import { ackTimeout } from './fixtures/ack-timeout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  fixture,
  until,
  choice,
  savedEntries,
  releasedEntries,
} from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
test('selection keeps its admission grant through native model discovery', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.pool.resolve(await bridge.session(id));
  const runtime = bridge.pool.get(id),
    command = runtime.command.bind(runtime);
  runtime.command = async (input, ...rest) => {
    const result = await command(input, ...rest);
    if (input.type === 'get_available_models')
      await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
    return result;
  };
  const selected = await bridge.send({
    session_id: id,

    text: 'ADMITTED',
    model: choice('vision'),
    thinking_level: 'high',
  });
  assert.ok(['started', 'queued', 'handled'].includes(selected.status), JSON.stringify(selected));
  const entries = await releasedEntries(bridge, id);
  assert.ok(entries.some((e) => e.type === 'model_change' && e.modelId === 'vision'));
  assert.ok(entries.some((e) => e.type === 'thinking_level_change' && e.thinkingLevel === 'high'));
  assert.equal(
    (await bridge.send({ session_id: id, text: 'DENIED' })).reason,
    'NOT_FOUND_OR_DENIED',
  );
});

for (const operation of ['send', 'create'])
  test(
    operation +
      ' model ACK timeout fences input; late ACK does not continue thinking selection or prompt submission',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge, id } = f;
      ackTimeout(t, ['set_model']);
      await fs.writeFile(f.gate + '.hold-selection', 'hold');
      const args = {
        model: choice('vision'),
        thinking_level: 'high',
        ...(operation === 'create'
          ? { project: f.cwd, text: 'NEVER_SENT' }
          : { session_id: id, text: 'NEVER_SENT' }),
      };
      const result = await bridge[operation](args);
      assert.equal(result.status, 'unknown', JSON.stringify(result));
      const target = result.session_id ?? id,
        runtime = bridge.pool.get(target);
      assert.ok(runtime.modelMutation);
      const blocked = await bridge.send({
        session_id: target,

        text: 'NEVER_SENT',
      });
      assert.equal(blocked.status, 'rejected');
      assert.equal(blocked.reason, 'MODEL_SELECTION_PENDING');
      assert.equal(
        (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
        0,
      );
      await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
      await fs.writeFile(f.gate, 'go');
      await until(() => !runtime.modelMutation);
      const recover = operation === 'create' ? { project: f.cwd } : { session_id: target };
      assert.equal(
        (await bridge[operation]({ ...args, ...recover })).reason,
        'NOT_FOUND_OR_DENIED',
      );
      await fs.writeFile(f.configFile, JSON.stringify(f.config));
      assert.equal((result.send ?? result).model_selection, undefined);
      const entries = await releasedEntries(bridge, target);
      assert.equal(entries.findLast((e) => e.type === 'model_change').modelId, 'vision');
      assert.ok(
        !entries.some((e) => e.type === 'thinking_level_change' && e.thinkingLevel === 'high'),
      );

      assert.equal(
        (await savedEntries(bridge, target)).filter((e) => e.message?.role === 'user').length,
        0,
      );
      if (operation === 'create') assert.equal((await bridge.sessions()).length, 2);
      await bridge.close();
      const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
      try {
        assert.equal(restarted.pool.instances.size, 0);
      } finally {
        await restarted.close();
      }
    },
  );

test('cold selection retains its admission snapshot', { timeout: 15000 }, async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const resolve = bridge.pool.resolve.bind(bridge.pool);
  bridge.pool.resolve = async (session) => {
    const next = await resolve(session);
    await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
    return next;
  };
  const accepted = await bridge.send({
    session_id: id,

    text: 'ADMITTED',
    model: choice('vision'),
  });
  assert.ok(['started', 'queued', 'handled'].includes(accepted.status), JSON.stringify(accepted));
  assert.equal(
    (await bridge.send({ session_id: id, text: 'DENIED' })).reason,
    'NOT_FOUND_OR_DENIED',
  );
  const entries = await releasedEntries(bridge, id);
  assert.ok(entries.some((e) => e.type === 'model_change' && e.modelId === 'vision'));
  assert.ok(entries.some((e) => e.message?.role === 'user'));
});
