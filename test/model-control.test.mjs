import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, idle, until, choice } from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
test('selection rechecks a revoked grant after native model discovery and before any setting write', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.models({ session_id: id, start: true });
  const runtime = bridge.pool.get(id),
    command = runtime.command.bind(runtime);
  runtime.command = async (input, ...rest) => {
    const result = await command(input, ...rest);
    if (input.type === 'get_available_models')
      await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
    return result;
  };
  const rejected = await bridge.set_model({
    session_id: id,
    request_id: 'revoke-after-models',
    model: choice('vision'),
    thinking_level: 'high',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'NOT_FOUND_OR_DENIED');
  const state = await runtime.state();
  assert.equal(state.model.id, 'alpha');
  assert.equal(state.thinkingLevel, 'off');
});

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
function replies(entries) {
  return entries
    .filter((e) => e.message?.role === 'assistant')
    .flatMap((e) =>
      e.message.content
        .filter((c) => c.type === 'text' && c.text.startsWith('MODEL_INPUT:'))
        .map((c) => JSON.parse(c.text.slice('MODEL_INPUT:'.length))),
    );
}
for (const mode of ['steer', 'follow_up'])
  test(
    'standalone selection changes future ' + mode + ' calls, not the in-flight response',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge, id } = f;
      assert.equal(
        (await bridge.send({ session_id: id, request_id: 'active', text: 'HOLD_MODEL' })).status,
        'accepted',
      );
      const runtime = bridge.pool.get(id);
      assert.equal(
        (await bridge.send({ session_id: id, request_id: 'queued', text: 'NEXT', mode }))
          .disposition,
        'queued',
      );
      const selected = await bridge.set_model({
        session_id: id,
        request_id: 'switch',
        model: choice('vision'),
      });
      assert.equal(selected.status, 'accepted');
      assert.equal((await runtime.state()).model.id, 'vision');
      await fs.writeFile(f.gate, 'go');
      await idle(runtime);
      assert.deepEqual(
        replies((await runtime.entries()).entries).map((r) => r.id),
        ['alpha', 'vision'],
      );
      assert.deepEqual(await bridge.set_model({ session_id: id, request_id: 'switch' }), selected);
      await assert.rejects(
        bridge.set_model({ session_id: id, request_id: 'switch', model: choice('alpha') }),
        /REQUEST_ID_CONFLICT/,
      );
      assert.equal((await runtime.state()).model.id, 'vision');
    },
  );

test(
  'standalone selection during a native tool applies at its continuation call',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const sent = await bridge.send({ session_id: id, request_id: 'tool-turn', text: 'USE_TOOL' });
    assert.equal(sent.status, 'accepted');
    const runtime = bridge.pool.get(id);
    await until(() => exists(f.gate + '.tool-start'));
    const selected = await bridge.set_model({
      session_id: id,
      request_id: 'tool-switch',
      model: choice('vision'),
    });
    assert.equal(selected.status, 'accepted');
    await fs.writeFile(f.gate, 'go');
    await idle(runtime);
    assert.equal(replies((await runtime.entries()).entries).at(-1).id, 'vision');
  },
);

for (const operation of ['send', 'create', 'set_model'])
  test(
    operation +
      ' selection timeout fences new input, late ACK repairs only the outcome and never sends a prompt',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge, id } = f;
      await fs.writeFile(f.gate + '.hold-selection', 'hold');
      const args = {
        request_id: 'selection-timeout',
        model: choice('vision'),
        timeout_ms: 50,
        ...(operation === 'create'
          ? { project: f.cwd, text: 'NEVER_SENT' }
          : operation === 'send'
            ? { session_id: id, text: 'NEVER_SENT' }
            : { session_id: id }),
      };
      const result = await bridge[operation](args);
      assert.equal(result.status, 'unknown', JSON.stringify(result));
      const target = result.session_id ?? id,
        runtime = bridge.pool.get(target);
      assert.ok(runtime.modelMutation);
      const blocked = await bridge.send({
        session_id: target,
        request_id: 'cannot-race',
        text: 'NEVER_SENT',
      });
      assert.equal(blocked.status, 'rejected');
      assert.equal(blocked.reason, 'MODEL_SELECTION_PENDING');
      assert.equal(
        (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
        0,
      );
      await fs.writeFile(f.gate, 'go');
      await until(async () => {
        const r = await bridge.journal.get(args.request_id);
        return r?.receipt.status !== 'unknown';
      });
      const recover =
        operation === 'create'
          ? { project: f.cwd, request_id: args.request_id }
          : { session_id: target, request_id: args.request_id };
      const terminal = await bridge[operation](recover);
      assert.equal(terminal.status, operation === 'set_model' ? 'accepted' : 'rejected');
      if (operation !== 'set_model') {
        const send = terminal.send ?? terminal;
        assert.equal(send.reason, 'MODEL_SELECTED_PROMPT_NOT_SENT');
        assert.equal(send.model_selection.status, 'selected');
      }
      assert.equal((await runtime.state()).model.id, 'vision');
      assert.deepEqual(await bridge[operation](args), terminal);
      assert.equal(
        (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
        0,
      );
      if (operation === 'create') assert.equal((await bridge.sessions()).length, 2);
      await bridge.close();
      const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
      try {
        assert.deepEqual(await restarted[operation](recover), terminal);
        assert.equal(restarted.pool.instances.size, 0);
      } finally {
        await restarted.close();
      }
    },
  );

test(
  'model discovery rechecks grants after capture; switching rechecks after cold startup',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    await bridge.models({ session_id: id, start: true });
    const runtime = bridge.pool.get(id),
      native = runtime.models.bind(runtime),
      grants = structuredClone(f.config.grants);
    runtime.models = async (args) => {
      const result = await native(args);
      await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
      return result;
    };
    await assert.rejects(bridge.models({ session_id: id }), /NOT_FOUND_OR_DENIED/);
    await bridge.pool.stop(id);
    await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants }));
    const resolve = bridge.pool.resolve.bind(bridge.pool);
    bridge.pool.resolve = async (session) => {
      const next = await resolve(session);
      await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
      return next;
    };
    const denied = await bridge.set_model({
      session_id: id,
      request_id: 'cold-revoke',
      model: choice('vision'),
    });
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.reason, 'NOT_FOUND_OR_DENIED');
    assert.equal((await bridge.pool.get(id).state()).model.id, 'alpha');
  },
);
