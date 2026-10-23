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
import { publicSchemas } from '../src/tool-schemas.mjs';
import { callBridgeTool, META, MODERN_VERSION } from '../src/protocol.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { createStdioProxy } from '../src/stdio-proxy.mjs';
import { PassThrough } from 'node:stream';
import { executeBatch } from '../src/batch.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

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

test('native model selection keeps project authorization when its workspace disappears during dispatch', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f,
    runtime = await bridge.pool.resolve(await bridge.session(id)),
    select = runtime.selectModel.bind(runtime);
  t.mock.method(runtime, 'selectModel', async (...args) => {
    await fs.rename(f.cwd, f.cwd + '-moved');
    return select(...args);
  });
  assert.deepEqual(await bridge.set_model({ session_id: id, model: choice('vision') }), {
    model: choice('vision'),
    thinking_level: 'off',
  });
  const identity = await bridge.session(id);
  assert.equal(identity.projectCwd, f.cwd);
  assert.equal(identity.cwd, null);
});

test('a timed-out native setter remains fenced until its exact ACK and never applies later steps', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  const command = runtime.command.bind(runtime);
  t.mock.method(runtime, 'command', (input, timeout, ...rest) =>
    command(input, input.type === 'set_model' ? 50 : timeout, ...rest),
  );
  await fs.writeFile(f.gate + '.hold-selection', 'hold');
  await assert.rejects(
    bridge.set_model({
      session_id: id,
      model: choice('vision'),
      thinking_level: 'high',
    }),
    (e) => e.message === 'ACK_TIMEOUT' && e.uncertain === true,
  );
  assert.ok(runtime.modelMutation);
  await assert.rejects(
    bridge.set_model({ session_id: id, thinking_level: 'low' }),
    /MODEL_SELECTION_PENDING/,
  );
  assert.equal(
    (await bridge.send({ session_id: id, text: 'NEVER_SENT' })).reason,
    'MODEL_SELECTION_PENDING',
  );
  await fs.writeFile(f.gate, 'go');
  await until(() => !runtime.modelMutation);
  assert.equal((await runtime.state()).thinkingLevel, 'off');
  assert.equal((await runtime.entries()).entries.filter((e) => e.message).length, 0);
});

test('native selection remains available during unresolved prompt preflight and Stop control', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  const pending = runtime.command({ type: 'prompt', message: 'HOLD_PREFLIGHT' }, 5000);
  const stopEntered = Promise.withResolvers(),
    stopRelease = Promise.withResolvers();
  let stopping;
  try {
    await until(() => exists(f.gate + '.preflight-start'));
    assert.ok(runtime.promptAdmission);
    assert.deepEqual(
      await bridge.set_model({
        session_id: id,
        model: choice('vision'),
        thinking_level: 'high',
      }),
      { model: choice('vision'), thinking_level: 'high' },
    );
    assert.ok(runtime.promptAdmission, 'Setter does not settle or abort the pending prompt');
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
    assert.ok(bridge.locks.has('stop:' + id));
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

test('set_model uses the receive-time send grant and new calls reauthorize, including batch lanes', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const second = (await savedSession(bridge)).session_id;
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  await fs.writeFile(
    f.configFile,
    JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
  );
  const capture = bridge.captureRequestContext.bind(bridge);
  let snapshot;
  t.mock.method(bridge, 'captureRequestContext', () => (snapshot = capture()));
  const result = await callBridgeTool(
    bridge,
    'batch',
    {
      operations: [
        {
          op: 'set_model',
          args: { session_id: id, model: choice('vision'), thinking_level: 'high' },
        },
        { op: 'set_model', args: { session_id: id, model: choice('missing') } },
        { op: 'set_model', args: { session_id: id, thinking_level: 'off' } },
        { op: 'set_model', args: { session_id: second, thinking_level: 'low' } },
      ],
    },
    {
      execute: async (run) => {
        await snapshot;
        await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
        return run();
      },
    },
  );
  assert.ok(!result.isError, JSON.stringify(result));
  const items = result.structuredContent.results;
  assert.deepEqual(items[0].result, { model: choice('vision'), thinking_level: 'high' });
  assert.equal(items[1].error.code, 'MODEL_UNAVAILABLE');
  assert.deepEqual(items[2].result, { model: choice('vision'), thinking_level: 'off' });
  assert.deepEqual(items[3].result, { model: choice('alpha'), thinking_level: 'off' });
  await assert.rejects(
    bridge.set_model({ session_id: id, thinking_level: 'high' }),
    /NOT_FOUND_OR_DENIED/,
  );
  assert.equal((await runtime.entries()).entries.filter((e) => e.message).length, 0);
  await releasedEntries(bridge, second);
  assert.equal((await savedEntries(bridge, second)).filter((e) => e.message).length, 0);
});

test('HTTP and stdio proxy expose set_model with the same minimal contract and no replay', async (t) => {
  const { bridge, id } = await fixture(t);
  const runtime = await bridge.pool.resolve(await bridge.session(id));
  const token = 'synthetic-set-model-token-not-a-real-credential';
  const service = createHttpService(bridge, { token }),
    url = await service.listen();
  const input = new PassThrough(),
    output = new PassThrough();
  let wire = '';
  output.on('data', (chunk) => {
    wire += chunk;
  });
  const proxy = createStdioProxy({ url, token, input, output });
  t.after(async () => {
    await proxy.close();
    await service.close();
  });
  const message = (request, args) => ({
    jsonrpc: '2.0',
    id: request,
    method: 'tools/call',
    params: {
      name: 'set_model',
      arguments: args,
      _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
    },
  });
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TOKEN_HEADER]: token,
      'MCP-Protocol-Version': MODERN_VERSION,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'set_model',
    },
    body: JSON.stringify(
      message(1, { session_id: id, model: choice('vision'), thinking_level: 'high' }),
    ),
  });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result.structuredContent, {
    model: choice('vision'),
    thinking_level: 'high',
  });
  await proxy.start();
  input.write(JSON.stringify(message(2, { session_id: id, model: choice('alpha') })) + '\n');
  await proxy.drain();
  assert.deepEqual(JSON.parse(wire.trim()).result.structuredContent, {
    model: choice('alpha'),
    thinking_level: 'off',
  });
  assert.equal((await runtime.entries()).entries.filter((e) => e.message).length, 0);
});

test('set_model validates selection settings before starting a runtime', async (t) => {
  const { bridge, id } = await fixture(t);
  for (const extra of [
    {},
    { model: {} },
    { thinking_level: 'invalid' },
    { thinking_level: 'high', timeout_ms: 50 },
    { thinking_level: 'high', text: 'not a prompt' },
  ]) {
    assert.equal(publicSchemas.set_model.safeParse({ session_id: id, ...extra }).success, false);
    await assert.rejects(bridge.set_model({ session_id: id, ...extra }), /INVALID_ARGUMENTS/);
  }
  assert.equal(bridge.pool.instances.size, 0);
  const batch = await executeBatch(bridge, {
    operations: [
      { op: 'set_model', args: { session_id: id } },
      { op: 'set_model', args: { session_id: id, thinking_level: 'off' } },
    ],
  });
  assert.equal(batch.results[0].error.code, 'INVALID_OPERATION');
  assert.deepEqual(batch.results[1].result, { model: choice('alpha'), thinking_level: 'off' });
});

test(
  'thinking-only owned RPC selection follows a local model change and never restores its earlier observation',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await f.bridge.pool.resolve(await f.bridge.session(f.id));
    const state = runtime.state.bind(runtime),
      dispatch = runtime.dispatch.bind(runtime);
    let sampled = false,
      local = false,
      modelWrites = 0;
    t.mock.method(runtime, 'dispatch', (command, ...args) => {
      if (command.type === 'set_model' && !local) modelWrites++;
      return dispatch(command, ...args);
    });
    t.mock.method(runtime, 'state', async (...args) => {
      const value = await state(...args);
      if (!sampled) {
        sampled = true;
        local = true;
        try {
          await runtime.command({
            type: 'set_model',
            provider: 'model-fixture',
            modelId: 'vision',
          });
        } finally {
          local = false;
        }
      }
      return value;
    });
    assert.deepEqual(await f.bridge.set_model({ session_id: f.id, thinking_level: 'high' }), {
      model: { provider: 'model-fixture', id: 'vision' },
      thinking_level: 'high',
    });
    assert.equal(modelWrites, 0);
    assert.equal((await state()).model.contextWindow, 32000);
    await f.bridge.set_model({
      session_id: f.id,
      model: { provider: 'model-fixture', id: 'alpha' },
    });
    assert.equal(modelWrites, 1);
  },
);

for (const op of ['send', 'create'])
  test(
    'local selection changes after ' +
      op +
      ' preflight reject its prompt without restoring the previous model',
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
      const result = await f.bridge[op]({
        ...(op === 'send' ? { session_id: f.id } : { project: f.cwd }),
        text: 'NEVER_DISPATCH',
        model: { provider: 'model-fixture', id: 'vision' },
        thinking_level: 'high',
      });
      const receipt = result.send ?? result;
      assert.equal(receipt.status, 'rejected', JSON.stringify(result));
      assert.equal(receipt.reason, 'MODEL_SELECTION_CHANGED');
      const target = result.session_id ?? f.id;
      const entries = await releasedEntries(f.bridge, target);
      assert.equal(entries.filter((e) => e.message?.role === 'user').length, 0);
      assert.equal(entries.findLast((e) => e.type === 'model_change').modelId, 'alpha');
    },
  );
