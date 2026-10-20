import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, idle, until } from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
async function populate(f) {
  await f.bridge.send({
    session_id: f.id,
    request_id: 'history',
    text: 'KEEP_HISTORY '.repeat(200),
  });
  const runtime = f.bridge.pool.get(f.id);
  await idle(runtime);
  return runtime;
}

test(
  'idle compact needs send, not stop/read; native summary stays read-protected and exact replay cannot compact twice',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await populate(f),
      { bridge, id } = f;
    await fs.writeFile(
      f.configFile,
      JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
    );
    const args = { session_id: id, request_id: 'compact', instructions: 'RETAIN_THE_MARKER' };
    const result = await bridge.compact(args);
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.equal(result.completion, 'completed');
    assert.equal(result.interrupt_requested, false);
    assert.ok(!JSON.stringify(result).includes('RETAIN_THE_MARKER'));
    assert.ok(!('summary' in result));
    const entries = (await runtime.entries()).entries;
    assert.equal(entries.filter((e) => e.type === 'compaction').length, 1);
    assert.ok(entries.find((e) => e.type === 'compaction').summary.includes('RETAIN_THE_MARKER'));
    assert.deepEqual(await bridge.compact({ ...args }), result);
    assert.deepEqual(
      await bridge.compact({ session_id: id, request_id: 'compact', recover: true }),
      result,
    );
    await assert.rejects(
      bridge.compact({ ...args, instructions: 'DIFFERENT' }),
      /REQUEST_ID_CONFLICT/,
    );
    await assert.rejects(
      bridge.compact({ ...args, request_id: 'interrupt-denied', interrupt: true }),
      /NOT_FOUND_OR_DENIED/,
    );
    await assert.rejects(bridge.read({ session_id: id }), /NOT_FOUND_OR_DENIED/);
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'compaction').length,
      1,
    );
  },
);

test(
  'default compact refuses busy without aborting; explicit interrupt requires and uses stop authorization',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await populate(f),
      { bridge, id } = f;
    await bridge.send({ session_id: id, request_id: 'active', text: 'HOLD_MODEL' });
    const refused = await bridge.compact({ session_id: id, request_id: 'idle-compact' });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'COMPACT_BUSY');
    assert.equal((await runtime.state()).isStreaming, true);
    const interrupted = await bridge.compact({
      session_id: id,
      request_id: 'interrupt-compact',
      interrupt: true,
    });
    assert.equal(interrupted.status, 'accepted', JSON.stringify(interrupted));
    assert.equal(interrupted.interrupt_requested, true);
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'compaction').length,
      1,
    );
    await fs.writeFile(
      f.configFile,
      JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
    );
    await assert.rejects(
      bridge.compact({ session_id: id, request_id: 'interrupt-compact', recover: true }),
      /NOT_FOUND_OR_DENIED/,
    );
  },
);

test(
  'timeout compact retains an input fence and late durable completion recovers across restart',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await populate(f),
      { bridge, id } = f;
    const result = await bridge.compact({
      session_id: id,
      request_id: 'slow',
      instructions: 'HOLD_COMPACT',
      timeout_ms: 50,
    });
    assert.equal(result.status, 'unknown');
    const blocked = await bridge.send({ session_id: id, request_id: 'blocked', text: 'NEVER' });
    assert.equal(blocked.reason, 'COMPACTION_PENDING');
    await fs.writeFile(f.gate, 'go');
    await until(async () => (await bridge.journal.get('slow'))?.receipt.status === 'accepted');
    const finished = await bridge.compact({ session_id: id, request_id: 'slow', recover: true });
    assert.equal(finished.status, 'accepted');
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'compaction').length,
      1,
    );
    await bridge.close();
    const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
    try {
      assert.deepEqual(
        await restarted.compact({ session_id: id, request_id: 'slow', recover: true }),
        finished,
      );
      assert.equal(restarted.pool.instances.size, 0);
    } finally {
      await restarted.close();
    }
  },
);

test(
  'native stop cancels a held compact; no second compaction on recovery',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await populate(f),
      { bridge, id } = f;
    const compacting = bridge.compact({
      session_id: id,
      request_id: 'cancelled',
      instructions: 'HOLD_COMPACT',
    });
    await until(() => exists(f.gate + '.compact-start'));
    const stop = await bridge.stop({ session_id: id, request_id: 'cancel-compact' });
    assert.equal(stop.status, 'accepted', JSON.stringify(stop));
    const result = await compacting;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'PI_REJECTED');
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'compaction').length,
      0,
    );
    assert.deepEqual(
      await bridge.compact({ session_id: id, request_id: 'cancelled', recover: true }),
      result,
    );
  },
);

test(
  'native extension cancellation is a negative receipt, not a successful compact',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await populate(f);
    const result = await f.bridge.compact({
      session_id: f.id,
      request_id: 'cancel-hook',
      instructions: 'CANCEL_COMPACT',
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'PI_REJECTED');
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'compaction').length,
      0,
    );
  },
);
