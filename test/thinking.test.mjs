import { ackTimeout } from './fixtures/ack-timeout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {
  fixture,
  until,
  choice,
  releasedEntries,
  savedEntries,
} from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
const replies = (entries) =>
  entries
    .filter((e) => e.message?.role === 'assistant')
    .map((e) => JSON.parse(e.message.content[0].text.slice('MODEL_INPUT:'.length)));
const identity = (op, f) => (op === 'create' ? { project: f.cwd } : { session_id: f.id });
const target = (result, f) => result.session_id ?? f.id;
const sendReceipt = (result) => result.send ?? result;

for (const op of ['send', 'create']) {
  for (const kind of ['model', 'thinking', 'both']) {
    test(
      op + ' applies ' + kind + ' settings to its first provider call',
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t),
          { bridge } = f;
        if (kind === 'thinking') f.config.piArgs[f.config.piArgs.indexOf('--model') + 1] = 'vision';
        const defaults = await fs.readFile(f.settings, 'utf8');
        const args = {
          ...identity(op, f),
          text: 'CONFIGURED',
          ...(kind !== 'thinking' ? { model: choice('vision') } : {}),
          ...(kind !== 'model' ? { thinking_level: 'high' } : {}),
        };
        const result = await bridge[op](args),
          receipt = sendReceipt(result),
          id = target(result, f);
        assert.ok(
          ['started', 'queued', 'handled'].includes(receipt.status),
          JSON.stringify(result),
        );
        const effective = receipt.model_selection;
        assert.deepEqual(effective.model, choice('vision'));
        if (kind !== 'model') assert.equal(effective.thinking_level, 'high');
        const entries = await releasedEntries(bridge, id),
          reply = replies(entries)[0];
        assert.equal(reply.id, 'vision');
        assert.equal(
          reply.reasoning,
          effective.thinking_level === 'off' ? null : effective.thinking_level,
        );
        assert.equal(entries.filter((e) => e.message?.role === 'user').length, 1);
        assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
        assert.deepEqual(await savedEntries(bridge, id), entries);
        assert.equal(bridge.pool.instances.size, 0);
      },
    );
  }

  test(
    op + ' rejects unsupported thinking before changing model or admitting its prompt',
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t),
        { bridge } = f;
      const result = await bridge[op]({
        ...identity(op, f),

        text: 'NEVER',
        model: choice('alpha'),
        thinking_level: 'high',
      });
      const receipt = sendReceipt(result),
        id = target(result, f);
      assert.equal(receipt.status, 'rejected');
      assert.equal(receipt.reason, 'THINKING_LEVEL_UNSUPPORTED');
      assert.equal(receipt.model_selection, undefined);
      const entries = await releasedEntries(bridge, id);
      assert.equal(entries.filter((e) => e.message?.role === 'user').length, 0);
      assert.ok(
        !entries.some((e) => e.type === 'thinking_level_change' && e.thinkingLevel === 'high'),
      );
    },
  );

  test(
    op + ' late model ACK reports partial settings without applying thinking or sending input',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge } = f;
      ackTimeout(t, ['set_model']);
      await fs.writeFile(f.gate + '.hold-selection', 'hold');
      const args = {
        ...identity(op, f),

        text: 'NEVER',
        model: choice('vision'),
        thinking_level: 'high',
      };
      const result = await bridge[op](args),
        id = target(result, f);
      assert.equal(sendReceipt(result).status, 'unknown');
      assert.equal(
        (await bridge.send({ session_id: id, text: 'NEVER' })).reason,
        'MODEL_SELECTION_PENDING',
      );
      await fs.writeFile(f.gate, 'go');
      await until(() => !bridge.pool.get(id)?.modelMutation);
      assert.equal(sendReceipt(result).model_selection, undefined);
      const entries = await releasedEntries(bridge, id);
      assert.equal(entries.findLast((e) => e.type === 'model_change').modelId, 'vision');
      assert.equal(entries.filter((e) => e.message?.role === 'user').length, 0);
      assert.ok(
        !entries.some((e) => e.type === 'thinking_level_change' && e.thinkingLevel === 'high'),
      );

      await bridge.close();
      const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
      try {
        assert.equal(restarted.pool.instances.size, 0);
      } finally {
        await restarted.close();
      }
    },
  );

  test(
    op + ' late thinking ACK repairs settings evidence and never sends the pending prompt',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge } = f,
        factory = bridge.pool.factory;
      ackTimeout(t, ['set_thinking_level']);
      let held, rpc, receive;
      bridge.pool.factory = async (session) => {
        rpc = await factory(session);
        receive = rpc.receiveResponse.bind(rpc);
        rpc.receiveResponse = (event, generation) => {
          if (event.type === 'response' && event.command === 'set_thinking_level') {
            held = [event, generation];
            return;
          }
          return receive(event, generation);
        };
        return rpc;
      };
      const args = {
        ...identity(op, f),

        text: 'NEVER',
        model: choice('vision'),
        thinking_level: 'high',
      };
      const result = await bridge[op](args),
        id = target(result, f);
      assert.equal(sendReceipt(result).status, 'unknown');
      assert.ok(held);
      assert.equal(
        (await bridge.send({ session_id: id, text: 'NEVER' })).reason,
        'MODEL_SELECTION_PENDING',
      );
      receive(...held);
      await until(() => !bridge.pool.get(id)?.modelMutation);
      assert.equal(sendReceipt(result).model_selection, undefined);
      assert.equal(
        (await releasedEntries(bridge, id)).filter((e) => e.message?.role === 'user').length,
        0,
      );
    },
  );
}

test(
  'omitted settings preserve native session selection, including cold resume without CLI overrides',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    await bridge.pool.resolve(await bridge.session(id));
    const rpc = bridge.pool.get(id);
    await rpc.selectModel(choice('vision'), { thinkingLevel: 'high', idle: true });
    for (const flag of ['--provider', '--model', '--thinking'])
      f.config.piArgs.splice(f.config.piArgs.indexOf(flag), 2);
    for (const text of ['first', 'cold-next']) {
      const result = await bridge.send({ session_id: id, text });
      assert.ok(['started', 'queued', 'handled'].includes(result.status), JSON.stringify(result));
      assert.equal(result.model_selection, undefined);
      const reply = replies(await releasedEntries(bridge, id)).at(-1);
      assert.equal(reply.id, 'vision');
      assert.equal(reply.reasoning, 'high');
    }
  },
);

test(
  'busy settings cannot alter a running request or queued input',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (
          await bridge.send({
            session_id: id,

            text: 'HOLD_MODEL',
            model: choice('vision'),
            thinking_level: 'high',
          })
        ).status,
      ),
      'Expected native prompt admission',
    );
    for (const mode of ['steer', 'follow_up', 'idle_only']) {
      const result = await bridge.send({
        session_id: id,

        text: 'NEVER',
        thinking_level: 'off',
        mode,
      });
      assert.equal(result.status, mode === 'idle_only' ? 'skipped' : 'rejected');
      assert.equal(result.reason, mode === 'idle_only' ? 'busy' : 'MODEL_SELECTION_BUSY');
    }
    assert.equal(
      (
        await bridge.send({
          session_id: id,

          text: 'QUEUED',
          mode: 'follow_up',
        })
      ).status,
      'queued',
    );
    await fs.writeFile(f.gate, 'go');
    const values = replies(await releasedEntries(bridge, id));
    assert.equal(values.length, 2);
    assert.ok(values.every((v) => v.id === 'vision' && v.reasoning === 'high'));
  },
);

for (const op of ['set_model', 'send', 'create'])
  test(
    op + ' model-only changes preserve current effort over native switch defaults',
    async (t) => {
      const f = await fixture(t),
        { bridge } = f;
      f.config.piArgs[f.config.piArgs.indexOf('--model') + 1] = 'vision';
      f.config.piArgs[f.config.piArgs.indexOf('--thinking') + 1] = 'high';
      const settings = JSON.parse(await fs.readFile(f.settings, 'utf8'));
      await fs.writeFile(
        f.settings,
        JSON.stringify({
          ...settings,
          defaultThinkingLevel: 'low',
          modelThinkingLevels: { 'model-fixture/reasoner': 'medium' },
        }),
      );
      const defaults = await fs.readFile(f.settings, 'utf8');
      const result = await bridge[op]({
        ...identity(op, f),
        model: choice('reasoner'),
        ...(op === 'set_model' ? {} : { text: 'KEEP_EFFORT' }),
      });
      const receipt = sendReceipt(result),
        selection = op === 'set_model' ? result : receipt.model_selection;
      assert.deepEqual(selection, { model: choice('reasoner'), thinking_level: 'high' });
      const entries = await releasedEntries(bridge, target(result, f));
      if (op === 'set_model') assert.equal(entries.filter((e) => e.message).length, 0);
      else assert.equal(replies(entries)[0].reasoning, 'high');
      assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
    },
  );

test(
  'model-only changes report native thinking adjustment without changing global defaults',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    await bridge.pool.resolve(await bridge.session(id));
    await bridge.pool.get(id).selectModel(choice('vision'), { thinkingLevel: 'high', idle: true });
    const defaults = await fs.readFile(f.settings, 'utf8');
    const result = await bridge.send({
      session_id: id,

      text: 'TEXT',
      model: choice('alpha'),
    });
    assert.ok(['started', 'queued', 'handled'].includes(result.status), JSON.stringify(result));
    assert.equal(result.model_selection.thinking_level, 'off');
    assert.equal(replies(await releasedEntries(bridge, id))[0].reasoning, null);
    assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
  },
);

test('prompt convenience schemas retain supported thinking levels', () => {
  for (const op of ['send', 'create']) {
    const args = {
      text: 'hello',
      thinking_level: 'high',
      ...(op === 'send' ? { session_id: 's' } : { project: '/project' }),
    };
    assert.equal(publicSchemas[op].safeParse(args).success, true);
    assert.equal(
      publicSchemas[op].safeParse({ ...args, thinking_level: 'unlimited' }).success,
      false,
    );
  }
});

test('settings alone require a prompt and never start a writer', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  for (const op of ['send', 'create'])
    await assert.rejects(
      bridge[op]({ ...identity(op, f), thinking_level: 'off' }),
      /INVALID_ARGUMENTS/,
    );
  assert.equal(bridge.pool.instances.size, 0);
});

test(
  'prompt ACK timeout retains verified settings and a late ACK never resubmits',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    await bridge.pool.resolve(await bridge.session(id));
    const rpc = bridge.pool.get(id),
      receive = rpc.receiveResponse.bind(rpc);
    ackTimeout(t, ['prompt']);
    let held;
    t.mock.method(rpc, 'receiveResponse', (event, generation) => {
      if (event.type === 'response' && event.command === 'prompt') {
        held = [event, generation];
        return;
      }
      return receive(event, generation);
    });
    const args = {
      session_id: id,

      text: 'ONCE',
      model: choice('vision'),
      thinking_level: 'high',
    };
    const unknown = await bridge.send(args);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.model_selection.thinking_level, 'high');
    await until(() => rpc.settlement.sequence > 0);
    receive(...held);
    const entries = await releasedEntries(bridge, id);
    assert.equal(entries.filter((e) => e.message?.role === 'user').length, 1);
    assert.equal(replies(entries)[0].reasoning, 'high');

    assert.deepEqual(await savedEntries(bridge, id), entries);
  },
);

test(
  'stop between native setting steps prevents the remaining setting and prompt',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    await bridge.pool.resolve(await bridge.session(id));
    const rpc = bridge.pool.get(id),
      command = rpc.command.bind(rpc);
    const entered = Promise.withResolvers(),
      finish = Promise.withResolvers();
    t.after(() => finish.resolve());
    t.mock.method(rpc, 'command', async (input, ...args) => {
      const result = await command(input, ...args);
      if (input.type === 'set_model') {
        entered.resolve();
        await finish.promise;
      }
      return result;
    });
    const sending = bridge.send({
      session_id: id,

      text: 'NEVER',
      model: choice('vision'),
      thinking_level: 'high',
    });
    await entered.promise;
    assert.equal((await bridge.stop({ session_id: id })).status, 'accepted');
    finish.resolve();
    const result = await sending;
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'STOP_IN_PROGRESS');
    const state = await rpc.state();
    assert.equal(state.model.id, 'vision');
    assert.equal(state.thinkingLevel, 'off');
    assert.ok(!(await rpc.entries()).entries.some((e) => e.message?.role === 'user'));
  },
);
