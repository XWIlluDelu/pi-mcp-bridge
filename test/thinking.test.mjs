import { ackTimeout } from './fixtures/ack-timeout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, until, choice, releasedEntries } from './fixtures/model-runtime.mjs';

const replies = (entries) =>
  entries
    .filter((e) => e.message?.role === 'assistant')
    .map((e) => JSON.parse(e.message.content[0].text.slice('MODEL_INPUT:'.length)));
const identity = (op, f) => (op === 'create' ? { project: f.cwd } : { session_id: f.id });
const target = (result, f) => result.session_id ?? f.id;
const sendReceipt = (result) => result.send ?? result;

for (const [op, kind] of [
  ['send', 'model'],
  ['send', 'thinking'],
  ['create', 'both'],
]) {
  test(
    op + ' applies ' + kind + ' settings to its first provider call',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        { bridge } = f;
      if (kind === 'thinking') {
        f.config.piArgs[f.config.piArgs.indexOf('--model') + 1] = 'vision';
        const launcher = f.dir + '/pi';
        await fs.symlink(f.config.piExecutable, launcher);
        f.config.piExecutable = launcher;
        await bridge.pool.resolve(f.session);
        await fs.unlink(launcher); // The running writer stays on its selected Pi installation.
      }
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
      assert.ok(['started', 'queued', 'handled'].includes(receipt.status), JSON.stringify(result));
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
    },
  );
}

for (const op of ['send', 'create']) {
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
}

test(
  'late thinking ACK clears the selection fence without sending the pending prompt',
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
      project: f.cwd,
      text: 'NEVER',
      model: choice('vision'),
      thinking_level: 'high',
    };
    const result = await bridge.create(args),
      id = target(result, f);
    assert.equal(sendReceipt(result).status, 'unknown');
    assert.ok(held);
    assert.equal(
      (await bridge.send({ session_id: id, text: 'NEVER' })).reason,
      'MODEL_SELECTION_PENDING',
    );
    receive(...held);
    await until(() => !bridge.pool.get(id)?.hasPendingModelSelection());
    assert.equal(sendReceipt(result).model_selection, undefined);
    assert.equal(
      (await releasedEntries(bridge, id)).filter((e) => e.message?.role === 'user').length,
      0,
    );
  },
);

test(
  'a missing prompt ACK retains settings and the writer until exact late admission',
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
    await until(() => rpc.settlementSequence > 0);
    await rpc.autoReleaseTask;
    assert.ok(held);
    assert.ok(rpc.hasPendingCommand('prompt'));
    assert.equal(rpc.child.stdin.writableEnded, false);
    receive(...held);
    const entries = await releasedEntries(bridge, id);
    assert.equal(entries.filter((e) => e.message?.role === 'user').length, 1);
    assert.equal(replies(entries)[0].reasoning, 'high');
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
