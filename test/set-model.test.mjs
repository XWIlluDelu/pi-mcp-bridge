import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, until, choice, releasedEntries } from './fixtures/model-runtime.mjs';
import { pngImage } from './fixtures/image-input.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { AttachedRuntime } from '../src/runtime/attachments.mjs';

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

test('standalone selection updates a busy native RPC without aborting its captured provider call', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const defaults = await fs.readFile(f.settings, 'utf8');
  assert.equal((await bridge.send({ session_id: id, text: 'HOLD_MODEL' })).status, 'started');
  await until(() => exists(f.gate + '.provider-start'));
  const runtime = bridge.pool.get(id);
  assert.deepEqual(
    await bridge.set_model({
      session_id: id,
      model: choice('vision'),
      thinking_level: 'high',
    }),
    { model: choice('vision'), thinking_level: 'high' },
  );
  assert.equal((await runtime.state()).isStreaming, true);
  assert.equal(await exists(f.gate + '.provider-aborted'), false);
  assert.equal(
    (
      await bridge.send({
        session_id: id,
        text: 'NEXT_PROVIDER_CALL',
        mode: 'follow_up',
      })
    ).status,
    'queued',
  );
  await fs.writeFile(f.gate, 'go');
  const entries = await releasedEntries(bridge, id);
  const replies = entries
    .filter((e) => e.message?.role === 'assistant')
    .map((e) => JSON.parse(e.message.content[0].text.slice('MODEL_INPUT:'.length)));
  assert.deepEqual(
    replies.map((r) => [r.id, r.reasoning]),
    [
      ['alpha', null],
      ['vision', 'high'],
    ],
  );
  assert.equal(entries.filter((e) => e.message?.role === 'user').length, 2);
  assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
});

test('a timed-out native setter remains fenced until its exact ACK and never applies later steps', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  ackTimeout(t, ['set_model']);
  await fs.writeFile(f.gate + '.hold-selection', 'hold');
  await assert.rejects(
    bridge.set_model({
      session_id: id,
      model: choice('vision'),
      thinking_level: 'high',
    }),
    (e) => e.message === 'ACK_TIMEOUT' && e.uncertain === true,
  );
  assert.ok(runtime.hasPendingCommand('set_model'));
  await assert.rejects(
    bridge.set_model({ session_id: id, thinking_level: 'low' }),
    /MODEL_SELECTION_PENDING/,
  );
  assert.equal(
    (await bridge.send({ session_id: id, text: 'NEVER_SENT' })).reason,
    'MODEL_SELECTION_PENDING',
  );
  await fs.writeFile(f.gate, 'go');
  await until(() => !runtime.hasPendingCommand('set_model'));
  assert.equal((await runtime.state()).thinkingLevel, 'off');
  assert.equal((await runtime.entries()).entries.filter((e) => e.message).length, 0);
});

test('native selection remains available during unresolved prompt preflight and Stop control', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  const pending = runtime.command({ type: 'prompt', message: 'HOLD_PREFLIGHT' }, { timeout: 5000 });
  const stopEntered = Promise.withResolvers(),
    stopRelease = Promise.withResolvers();
  let stopping;
  try {
    await until(() => exists(f.gate + '.preflight-start'));
    assert.ok(runtime.hasPendingCommand('prompt'));
    assert.deepEqual(
      await bridge.set_model({
        session_id: id,
        model: choice('vision'),
        thinking_level: 'high',
      }),
      { model: choice('vision'), thinking_level: 'high' },
    );
    assert.ok(
      runtime.hasPendingCommand('prompt'),
      'Setter does not settle or abort the pending prompt',
    );
    assert.equal(
      (
        await bridge.send({
          session_id: id,
          text: 'NO_INPUT',
          model: choice('alpha'),
        })
      ).reason,
      'PROMPT_ADMISSION_PENDING',
    );
    const stopExecution = runtime.stopExecution.bind(runtime);
    t.mock.method(runtime, 'stopExecution', async (args) => {
      stopEntered.resolve();
      await stopRelease.promise;
      return stopExecution(args);
    });
    stopping = bridge.stop({ session_id: id });
    await stopEntered.promise;
    assert.ok(Boolean(bridge.lane(id, 'stop')));
    assert.deepEqual(await bridge.set_model({ session_id: id, model: choice('alpha') }), {
      model: choice('alpha'),
      thinking_level: 'off',
    });
    assert.equal(
      (await bridge.send({ session_id: id, text: 'NO_INPUT' })).reason,
      'STOP_IN_PROGRESS',
    );
    stopRelease.resolve();
    assert.equal((await stopping).status, 'accepted');
  } finally {
    stopRelease.resolve();
    await fs.writeFile(f.gate + '.preflight-release', 'go');
    await stopping;
    await pending;
  }
  assert.equal((await pending).disposition, 'handled');
  assert.equal((await runtime.entries()).entries.filter((e) => e.message).length, 0);
});

test('cold setters return native thinking adjustment, produce no prompt and release their owned RPC', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const defaults = await fs.readFile(f.settings, 'utf8');
  assert.deepEqual(await bridge.set_model({ session_id: id, thinking_level: 'high' }), {
    model: choice('alpha'),
    thinking_level: 'off',
  });
  let entries = await releasedEntries(bridge, id);
  assert.equal(entries.filter((e) => e.message).length, 0);
  assert.deepEqual(
    await bridge.set_model({ session_id: id, model: choice('vision'), thinking_level: 'high' }),
    { model: choice('vision'), thinking_level: 'high' },
  );
  entries = await releasedEntries(bridge, id);
  assert.equal(entries.filter((e) => e.message).length, 0);
  assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
});

test('cold send restores a standalone model selection from a branch with no messages', async (t) => {
  const { bridge, id, settings } = await fixture(t, { modelArgs: [] });
  const defaults = await fs.readFile(settings, 'utf8');
  const selection = { model: choice('vision'), thinking_level: 'low' };
  assert.deepEqual(await bridge.set_model({ session_id: id, ...selection }), selection);
  const saved = await releasedEntries(bridge, id);
  assert.equal(
    saved.some((entry) => entry.type === 'message'),
    false,
  );
  assert.equal(saved.findLast((entry) => entry.type === 'model_change').modelId, 'vision');
  assert.equal(
    saved.findLast((entry) => entry.type === 'thinking_level_change').thinkingLevel,
    'low',
  );

  const sent = await bridge.send({
    session_id: id,
    text: 'Inspect the image',
    images: [pngImage()],
    mode: 'idle_only',
  });
  assert.equal(sent.status, 'started', JSON.stringify(sent));
  const entries = await releasedEntries(bridge, id);
  const reply = entries.find((entry) => entry.message?.role === 'assistant').message;
  assert.equal(reply.model, 'vision');
  const actual = JSON.parse(reply.content[0].text.slice('MODEL_INPUT:'.length));
  assert.equal(actual.reasoning, 'low');
  assert.equal(
    actual.content.some((block) => block.type === 'image'),
    true,
  );
  assert.equal(await fs.readFile(settings, 'utf8'), defaults);
});

test('explicit native model and thinking options override a saved empty-branch selection', async (t) => {
  const { bridge, id } = await fixture(t, {
    modelArgs: ['--model', 'model-fixture/reasoner:medium'],
  });
  const selection = { model: choice('vision'), thinking_level: 'low' };
  assert.deepEqual(await bridge.set_model({ session_id: id, ...selection }), selection);
  assert.equal(
    (await releasedEntries(bridge, id)).some((entry) => entry.message),
    false,
  );

  const sent = await bridge.send({ session_id: id, text: 'Use the launch options' });
  assert.equal(sent.status, 'started', JSON.stringify(sent));
  const entries = await releasedEntries(bridge, id);
  const reply = entries.find((entry) => entry.message?.role === 'assistant').message;
  assert.equal(reply.model, 'reasoner');
  const actual = JSON.parse(reply.content[0].text.slice('MODEL_INPUT:'.length));
  assert.equal(actual.reasoning, 'medium');
});

test(
  'local selection changes after prompt preflight reject dispatch without restoring the previous model',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      factory = f.bridge.pool.factory;
    f.bridge.pool.factory = async (session) => {
      const runtime = await factory(session),
        select = runtime.selectModel.bind(runtime);
      t.mock.method(runtime, 'selectModel', async (...args) => {
        const result = await select(...args);
        await runtime.command({ type: 'set_model', provider: 'model-fixture', modelId: 'alpha' });
        return result;
      });
      return runtime;
    };
    const result = await f.bridge.send({
      session_id: f.id,
      text: 'NEVER_DISPATCH',
      model: choice('vision'),
      thinking_level: 'high',
    });
    assert.equal(result.status, 'rejected', JSON.stringify(result));
    assert.equal(result.reason, 'MODEL_SELECTION_CHANGED');
    const entries = await releasedEntries(f.bridge, f.id);
    assert.equal(entries.filter((e) => e.message?.role === 'user').length, 0);
    assert.equal(entries.findLast((e) => e.type === 'model_change').modelId, 'alpha');
  },
);

test('send with model and thinking_level works on attached owners via set_model then submit', async (t) => {
  const f = await fixture(t);
  const attached = new AttachedRuntime(f.config, f.session, {});
  const request = t.mock.method(attached, 'request', async (op, body, { beforeDispatch }) => {
    beforeDispatch();
    return op === 'set_model' ? body : { status: 'dispatched', admission: 'unobservable' };
  });
  t.mock.method(f.bridge.pool, 'forRead', async () => attached);
  const result = await f.bridge.send({
    session_id: f.id,
    text: 'Run on companion',
    model: choice('vision'),
    thinking_level: 'high',
  });
  assert.equal(result.status, 'dispatched');
  assert.equal(result.admission, 'unobservable');
  assert.deepEqual(result.model_selection, { model: choice('vision'), thinking_level: 'high' });
  assert.deepEqual(
    request.mock.calls.map(({ arguments: args }) => args.slice(0, 2)),
    [
      ['set_model', { model: choice('vision'), thinking_level: 'high' }],
      ['send', { text: 'Run on companion', mode: 'steer', images: undefined }],
    ],
  );
});
