import { test } from 'node:test';
import packageInfo from '../package.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  dispatchModern,
  MODERN_VERSION,
  META,
  MCP_INPUT_LIMIT,
  toolDefinitions,
  callBridgeTool,
} from '../src/protocol.mjs';
import { BridgeStdioTransport } from '../src/protocol-stdio.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
import { CONTENT_KINDS } from '../src/read-schema.mjs';
import { MAX_IMAGES } from '../src/prompt-input.mjs';

const meta = { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} };
const message = (method, params = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: { ...params, _meta: { ...meta } },
});
const stub = { list: async (args) => ({ sessions: [], args }) };
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

test('oversized input collections reject before inspecting elements or admitting work', async () => {
  const bridge = { captureRequestContext: () => assert.fail('Invalid request reached admission') };
  for (const [name, field, limit, identity] of [
    ['batch', 'operations', 10, {}],
    ['read', 'refs', 8, { session_id: 'fixture' }],
    ['search', 'content', CONTENT_KINDS.length, { session_id: 'fixture', query: 'needle' }],
    ['send', 'images', MAX_IMAGES, { session_id: 'fixture' }],
    ['create', 'images', MAX_IMAGES, { project: '/fixture' }],
  ]) {
    const values = new Array(limit + 1);
    Object.defineProperty(values, 0, {
      get: () => assert.fail(`${name} inspected an element of an oversized collection`),
    });
    const args = { ...identity, [field]: values };
    const parsed = publicSchemas[name].safeParse(args);
    assert.equal(parsed.success, false);
    assert.equal(parsed.error.issues.length, 1);
    assert.equal(parsed.error.issues[0].code, 'too_big');
    assert.deepEqual(parsed.error.issues[0].path, [field]);
    const result = await callBridgeTool(bridge, name, args);
    assert.equal(result.structuredContent.error.code, 'INVALID_ARGUMENTS');
  }
});

test('public text limits retain UTF-16 units and trim search before validation', () => {
  for (const [name, field, limit, identity] of [
    ['search', 'query', 2048, { session_id: 'fixture' }],
    ['send', 'text', 100000, { session_id: 'fixture' }],
    ['compact', 'instructions', 100000, { session_id: 'fixture' }],
  ]) {
    const text = '😀'.repeat(limit / 2);
    assert.equal(publicSchemas[name].safeParse({ ...identity, [field]: text }).success, true);
    assert.equal(
      publicSchemas[name].safeParse({ ...identity, [field]: text + 'a' }).success,
      false,
    );
  }
  assert.equal(
    publicSchemas.search.parse({ session_id: 'fixture', query: ' '.repeat(2048) + 'needle ' })
      .query,
    'needle',
  );
});

test('modern requests are self-contained; discovery and tool list carry required fields', async () => {
  const discovery = await dispatchModern(stub, message('server/discover'));
  assert.equal(discovery.status, 200);
  assert.equal(discovery.message.result.resultType, 'complete');
  assert.ok(discovery.message.result.supportedVersions.includes(MODERN_VERSION));
  assert.equal(discovery.message.result.ttlMs, 0);
  assert.equal(discovery.message.result.cacheScope, 'private');
  assert.equal(discovery.message.result._meta[META + 'serverInfo'].name, 'pi-session-bridge');
  const listed = (await dispatchModern(stub, message('tools/list'))).message.result;
  assert.deepEqual(
    listed.tools.map((t) => t.name),
    [
      'list',
      'read',
      'search',
      'models',
      'set_model',
      'compact',
      'reload',
      'send',
      'submission',
      'command',
      'stop',
      'create',
      'delete',
      'batch',
      'health',
    ],
  );
  assert.deepEqual(discovery.message.result._meta[META + 'serverInfo'], {
    name: 'pi-session-bridge',
    version: packageInfo.version,
  });
  assert.equal(listed.ttlMs, 0);
  assert.equal(listed.cacheScope, 'private');
  const read = listed.tools.find((tool) => tool.name === 'read').inputSchema;
  assert.equal(
    read.properties.range.default,
    undefined,
    'Cursor-only continuation must not acquire a new range',
  );
  assert.equal(read.properties.range.properties.recent.minimum, -1);
  assert.equal(read.properties.content.properties.input.type, 'boolean');
  assert.equal(read.properties.content.properties.assistant.minimum, -1);
  assert.ok(!(read.required ?? []).includes('range'));
  const direct = await dispatchModern(
    stub,
    message('tools/call', { name: 'list', arguments: { project: 'abc' } }),
  );
  assert.deepEqual(direct.message.result.structuredContent.args, { project: 'abc' });
});
test('modern versions, required metadata and unknown methods use official error codes', async () => {
  const wrong = message('tools/list');
  wrong.params._meta[META + 'protocolVersion'] = '2099-01-01';
  const rejected = await dispatchModern(stub, wrong);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.message.error.code, -32022);
  assert.equal(rejected.message.error.data.requested, '2099-01-01');
  assert.ok(rejected.message.error.data.supported.includes(MODERN_VERSION));
  for (const key of [META + 'protocolVersion', META + 'clientCapabilities']) {
    const body = message('tools/list');
    delete body.params._meta[key];
    assert.equal((await dispatchModern(stub, body)).message.error.code, -32602);
  }
  assert.equal((await dispatchModern(stub, message('not/a/method'))).status, 404);
  assert.equal((await dispatchModern(stub, message('not/a/method'))).message.error.code, -32601);
  assert.equal(
    (await dispatchModern(stub, message('tools/call', { name: 'missing_tool' }))).message.error
      .code,
    -32602,
  );
});
test('public mutation payloads are validated before dispatch', async () => {
  const defs = toolDefinitions();
  assert.deepEqual(defs.find((t) => t.name === 'send').inputSchema.properties.mode.enum, [
    'steer',
    'follow_up',
    'idle_only',
  ]);
  const calls = [];
  const bridge = {
    create: async (args) => (calls.push(args), { status: 'started' }),
    reload: async (args) => (calls.push(args), { status: 'skipped', reason: 'no_active_owner' }),
  };
  const call = async (name, args) =>
    (await dispatchModern(bridge, message('tools/call', { name, arguments: args }))).message.result;
  const project = '/tmp/p';
  for (const args of [{ project }, { project, text: 'initial' }])
    assert.equal((await call('create', args)).isError, undefined);
  for (const args of [
    { project, thinking_level: 'high' },
    { project, unexpected: true },
  ])
    assert.equal((await call('create', args)).structuredContent.error.code, 'INVALID_ARGUMENTS');
  const target = { session_id: 'ps_test' };
  assert.deepEqual((await call('reload', target)).structuredContent, {
    status: 'skipped',
    reason: 'no_active_owner',
  });
  assert.equal(
    (await call('reload', { ...target, interrupt: true })).structuredContent.error.code,
    'INVALID_ARGUMENTS',
  );
  assert.deepEqual(calls, [{ project }, { project, text: 'initial' }, target]);
});
test('owner read refresh is a lifecycle error in text and structured tool results', async () => {
  const bridge = {
    read: async () => {
      throw new Error('OWNER_READ_REFRESH_REQUIRED');
    },
  };
  const response = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'read',
      arguments: { session_id: 'ps_' + 'a'.repeat(32) },
    }),
  );
  const result = response.message.result;
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.error.code, 'OWNER_READ_REFRESH_REQUIRED');
  assert.match(result.structuredContent.error.recovery, /idle boundary/);
  assert.match(result.structuredContent.error.recovery, /Call reload/);
  assert.match(result.structuredContent.error.recovery, /Changing read arguments will not/);
});

test('bounded stdio handles modern no-handshake calls, cancellation and oversized input', async () => {
  const input = new PassThrough(),
    output = new PassThrough(),
    lines = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  const entered = deferred(),
    release = deferred();
  const bridge = {
    list: async (_args, options) => {
      assert.equal(Object.hasOwn(options, 'signal'), false);
      entered.resolve();
      await release.promise;
      return { sessions: [] };
    },
  };
  const transport = new BridgeStdioTransport(bridge, { input, output });
  await transport.start();
  input.write(JSON.stringify(message('tools/call', { name: 'list', arguments: {} }, 42)) + '\n');
  await entered.promise;
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 42 },
    }) + '\n',
  );
  release.resolve();
  await transport.drain();
  assert.equal(lines.length, 0);
  input.write('x'.repeat(MCP_INPUT_LIMIT + 1) + '\n');
  input.write(JSON.stringify(message('ping', {}, 43)) + '\n');
  await transport.drain();
  assert.equal(lines[0].error.message, 'INPUT_TOO_LARGE');
  assert.equal(lines[1].id, 43);
  await transport.close();
});
