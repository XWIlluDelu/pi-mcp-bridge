import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, until, savedEntries } from './fixtures/model-runtime.mjs';
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
const released = (f) => until(() => !f.bridge.pool.instances.has(f.id));
async function populate(f) {
  const sent = await f.bridge.send({ session_id: f.id, text: 'KEEP_HISTORY '.repeat(200) });
  assert.equal(sent.status, 'started');
  await released(f);
}

test('too-small cold compact returns a safe native reason without changing history', async (t) => {
  const f = await fixture(t);
  const settings = JSON.parse(await fs.readFile(f.settings, 'utf8'));
  settings.compaction.keepRecentTokens = 20000;
  await fs.writeFile(f.settings, JSON.stringify(settings));
  await f.bridge.send({ session_id: f.id, text: 'SMALL_COMPACT_MARKER' });
  await released(f);
  const before = await savedEntries(f.bridge, f.id);
  assert.deepEqual(await f.bridge.compact({ session_id: f.id }), {
    status: 'rejected',
    reason: 'PI_REJECTED',
    native_reason: 'Nothing to compact (session too small)',
    native_effects: 'native_compact_attempted',
  });
  await released(f);
  assert.deepEqual(await savedEntries(f.bridge, f.id), before);
});

test('native summarizer completes compact with isolated settings and an offline provider', async (t) => {
  const f = await fixture(t);
  await populate(f);
  const result = await f.bridge.compact({
    session_id: f.id,
    instructions: 'NATIVE_COMPACT',
  });
  assert.equal(result.status, 'accepted', JSON.stringify(result));
  assert.equal(result.completion, 'completed');
  await released(f);
  const entries = await savedEntries(f.bridge, f.id);
  const compactions = entries.filter((entry) => entry.type === 'compaction');
  assert.equal(compactions.length, 1);
  assert.equal(compactions[0].fromHook, false);
  assert.ok(compactions[0].summary.length > 0);
});

test(
  'cold compact needs send, hides its native summary and releases when complete',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await populate(f);
    await fs.writeFile(
      f.configFile,
      JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
    );
    const args = { session_id: f.id, instructions: 'RETAIN_THE_MARKER' };
    const result = await f.bridge.compact(args);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.completion, 'completed');
    assert.equal(result.interrupt_requested, false);
    assert.ok(!JSON.stringify(result).includes('RETAIN_THE_MARKER'));
    assert.ok(!('summary' in result));
    await released(f);
    const entries = await savedEntries(f.bridge, f.id);
    assert.equal(entries.filter((e) => e.type === 'compaction').length, 1);
    assert.ok(entries.find((e) => e.type === 'compaction').summary.includes('RETAIN_THE_MARKER'));
    await assert.rejects(f.bridge.compact({ ...args, interrupt: true }), /NOT_FOUND_OR_DENIED/);
    await assert.rejects(f.bridge.read({ session_id: f.id }), /NOT_FOUND_OR_DENIED/);
  },
);

test(
  'default compact refuses busy without aborting; explicit interrupt requires and uses stop',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await populate(f);
    await f.bridge.send({ session_id: f.id, text: 'HOLD_MODEL' });
    const runtime = f.bridge.pool.get(f.id);
    const refused = await f.bridge.compact({ session_id: f.id });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'COMPACT_BUSY');
    assert.equal((await runtime.state()).isStreaming, true);
    const result = await f.bridge.compact({ session_id: f.id, interrupt: true });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.interrupt_requested, true);
    await released(f);
    assert.equal(
      (await savedEntries(f.bridge, f.id)).filter((e) => e.type === 'compaction').length,
      1,
    );
    await fs.writeFile(
      f.configFile,
      JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
    );
    await assert.rejects(
      f.bridge.compact({ session_id: f.id, interrupt: true }),
      /NOT_FOUND_OR_DENIED/,
    );
  },
);

test(
  'timed-out cold compact holds its fence through the late ACK, then releases without replay',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await populate(f);
    const result = await f.bridge.compact({
      session_id: f.id,
      instructions: 'HOLD_COMPACT',
      timeout_ms: 50,
    });
    const runtime = f.bridge.pool.get(f.id);
    assert.equal(result.status, 'unknown');
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'NEVER' })).reason,
      'COMPACTION_PENDING',
    );
    await until(() => exists(f.gate + '.compact-start'));
    assert.deepEqual(
      await f.bridge.set_model({
        session_id: f.id,
        model: { provider: 'model-fixture', id: 'vision' },
        thinking_level: 'high',
      }),
      { model: { provider: 'model-fixture', id: 'vision' }, thinking_level: 'high' },
    );
    assert.ok(runtime.compactionMutation);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'NEVER', thinking_level: 'off' })).reason,
      'MODEL_SELECTION_BUSY',
    );
    assert.equal(runtime.exited, false);
    await fs.writeFile(f.gate, 'go');
    await released(f);
    assert.equal(runtime.compactionMutation, null);
    assert.equal(
      (await savedEntries(f.bridge, f.id)).filter((e) => e.type === 'compaction').length,
      1,
    );
  },
);

test(
  'native stop cancels a held cold compact without generating a summary',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await populate(f);
    const compacting = f.bridge.compact({ session_id: f.id, instructions: 'HOLD_COMPACT' });
    await until(() => exists(f.gate + '.compact-start'));
    const stop = await f.bridge.stop({ session_id: f.id });
    assert.equal(stop.status, 'accepted', JSON.stringify(stop));
    const result = await compacting;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'PI_REJECTED');
    await released(f);
    assert.equal(
      (await savedEntries(f.bridge, f.id)).filter((e) => e.type === 'compaction').length,
      0,
    );
  },
);

test(
  'native extension cancellation refuses a cold compact and releases its idle writer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await populate(f);
    const result = await f.bridge.compact({ session_id: f.id, instructions: 'CANCEL_COMPACT' });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'PI_REJECTED');
    assert.equal(result.native_reason, 'Compaction cancelled');
    await released(f);
    assert.equal(
      (await savedEntries(f.bridge, f.id)).filter((e) => e.type === 'compaction').length,
      0,
    );
  },
);
