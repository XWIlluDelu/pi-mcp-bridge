import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, idle, until, choice } from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

test('model/thinking update is session-only, prevalidates both fields, reports native adjustment and never replays a setting', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const defaults = await fs.readFile(f.settings, 'utf8');
  const second = await savedSession(bridge);
  await bridge.models({ session_id: second.session_id, start: true });
  const both = await bridge.set_model({
    session_id: id,
    request_id: 'both',
    model: choice('vision'),
    thinking_level: 'high',
  });
  assert.equal(both.status, 'accepted');
  assert.equal(both.thinking_level, 'high');
  assert.equal(both.thinking_adjustment, 'none');
  const rejected = await bridge.set_model({
    session_id: id,
    request_id: 'unsupported',
    model: choice('alpha'),
    thinking_level: 'high',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.reason, 'THINKING_LEVEL_UNSUPPORTED');
  const runtime = bridge.pool.get(id);
  assert.equal((await runtime.state()).model.id, 'vision');
  assert.equal((await runtime.state()).thinkingLevel, 'high');
  const only = await bridge.set_model({
    session_id: id,
    request_id: 'thinking',
    thinking_level: 'low',
  });
  assert.equal(only.status, 'accepted');
  assert.equal(only.model.id, 'vision');
  assert.equal(only.thinking_level, 'low');
  await assert.rejects(
    bridge.set_model({ session_id: id, request_id: 'thinking', thinking_level: 'medium' }),
    /REQUEST_ID_CONFLICT/,
  );
  const changed = await bridge.set_model({
    session_id: id,
    request_id: 'model-only',
    model: choice('alpha'),
  });
  assert.equal(changed.thinking_level, 'off');
  assert.equal(changed.thinking_adjustment, 'native_adjustment');
  assert.deepEqual(await bridge.set_model({ session_id: id, request_id: 'both' }), both);
  assert.deepEqual(
    await bridge.set_model({
      session_id: id,
      request_id: 'both',
      model: choice('vision'),
      thinking_level: 'high',
    }),
    both,
  );
  assert.equal((await runtime.state()).model.id, 'alpha');
  assert.equal((await runtime.state()).thinkingLevel, 'off');
  assert.equal((await bridge.pool.get(second.session_id).state()).model.id, 'alpha');
  assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
  await assert.rejects(
    bridge.set_model({ session_id: id, request_id: 'invalid', thinking_level: 'unlimited' }),
    /INVALID_MODEL_ARGUMENTS/,
  );
});

test('thinking is captured per native provider call, including calls from already queued prompts', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.set_model({
    session_id: id,
    request_id: 'configure',
    model: choice('vision'),
    thinking_level: 'high',
  });
  await bridge.send({ session_id: id, request_id: 'first', text: 'HOLD_MODEL' });
  const runtime = bridge.pool.get(id);
  await bridge.send({ session_id: id, request_id: 'next', text: 'NEXT', mode: 'follow_up' });
  const changed = await bridge.set_model({
    session_id: id,
    request_id: 'while-busy',
    thinking_level: 'low',
  });
  assert.equal(changed.status, 'accepted');
  assert.equal(changed.thinking_level, 'low');
  await fs.writeFile(f.gate, 'go');
  await idle(runtime);
  const replies = (await runtime.entries()).entries
    .filter((e) => e.message?.role === 'assistant')
    .map((e) => JSON.parse(e.message.content[0].text.slice('MODEL_INPUT:'.length)));
  assert.deepEqual(
    replies.map((r) => r.reasoning),
    ['high', 'low'],
  );
});

test('timed-out model+thinking records partial selection and never applies thinking from its late model ACK', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await fs.writeFile(f.gate + '.hold-selection', 'hold');
  const args = {
    session_id: id,
    request_id: 'partial',
    model: choice('vision'),
    thinking_level: 'high',
    timeout_ms: 50,
  };
  assert.equal((await bridge.set_model(args)).status, 'unknown');
  await fs.writeFile(f.gate, 'go');
  await until(async () => (await bridge.journal.get('partial')).receipt.status !== 'unknown');
  const receipt = await bridge.set_model({ session_id: id, request_id: 'partial' });
  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.reason, 'MODEL_SELECTED_THINKING_NOT_SET');
  assert.equal(receipt.model.id, 'vision');
  assert.notEqual(receipt.thinking_level, 'high');
  assert.deepEqual(await bridge.set_model(args), receipt);
  assert.notEqual((await bridge.pool.get(id).state()).thinkingLevel, 'high');
});

test('late native thinking ACK fences input, durably repairs outcome, and restart does not repeat it', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.set_model({ session_id: id, request_id: 'model', model: choice('vision') });
  const runtime = bridge.pool.get(id),
    receive = runtime.receiveResponse.bind(runtime);
  let held;
  runtime.receiveResponse = (event, generation) => {
    if (event.type === 'response' && event.command === 'set_thinking_level' && !held) {
      held = [event, generation];
      return;
    }
    return receive(event, generation);
  };
  const args = {
    session_id: id,
    request_id: 'late-thinking',
    thinking_level: 'high',
    timeout_ms: 50,
  };
  const unknown = await bridge.set_model(args);
  assert.equal(unknown.status, 'unknown');
  assert.ok(held);
  assert.ok(runtime.modelMutation);
  const blocked = await bridge.send({ session_id: id, request_id: 'blocked', text: 'NEVER' });
  assert.equal(blocked.reason, 'MODEL_SELECTION_PENDING');
  runtime.receiveResponse = receive;
  receive(...held);
  await until(
    async () => (await bridge.journal.get(args.request_id)).receipt.status === 'accepted',
  );
  const receipt = await bridge.set_model({ session_id: id, request_id: args.request_id });
  assert.equal(receipt.thinking_level, 'high');
  assert.deepEqual(await bridge.set_model(args), receipt);
  assert.equal(
    (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
    0,
  );
  await bridge.close();
  const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
  try {
    assert.deepEqual(await restarted.set_model(args), receipt);
    assert.equal(restarted.pool.instances.size, 0);
  } finally {
    await restarted.close();
  }
});
