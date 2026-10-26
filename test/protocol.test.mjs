import { test } from 'node:test';
import packageInfo from '../package.json' with { type: 'json' };
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  dispatchModern,
  MODERN_VERSION,
  META,
  MCP_RESPONSE_LIMIT,
  MCP_INPUT_LIMIT,
  boundMessage,
  toolDefinitions,
  validateModernHeaders,
} from '../src/protocol.mjs';
import { BridgeStdioTransport } from '../src/protocol-stdio.mjs';

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
  let called = 0;
  const bridge = {
    create: async (args) => {
      called++;
      return { status: 'started' };
    },
    reload: async () => {
      called++;
      return { status: 'skipped', reason: 'no_active_owner' };
    },
  };
  const first = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'create',
      arguments: { project: '/tmp/p', text: 'initial' },
    }),
  );
  assert.equal(first.message.result.isError, undefined);
  const empty = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'create',
      arguments: { project: '/tmp/p' },
    }),
  );
  assert.equal(empty.message.result.isError, undefined);
  const settingsOnly = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'create',
      arguments: { project: '/tmp/p', thinking_level: 'high' },
    }),
  );
  assert.equal(settingsOnly.message.result.isError, true);
  const unknown = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'create',
      arguments: { project: '/tmp/p', text: 'initial', unexpected: true },
    }),
  );
  assert.equal(unknown.message.result.isError, true);
  assert.equal(called, 2);
  const reload = await dispatchModern(
    bridge,
    message('tools/call', { name: 'reload', arguments: { session_id: 'ps_test' } }),
  );
  assert.deepEqual(reload.message.result.structuredContent, {
    status: 'skipped',
    reason: 'no_active_owner',
  });
  const interruptReload = await dispatchModern(
    bridge,
    message('tools/call', {
      name: 'reload',
      arguments: { session_id: 'ps_test', interrupt: true },
    }),
  );
  assert.equal(interruptReload.message.result.structuredContent.error.code, 'INVALID_ARGUMENTS');
  assert.equal(called, 3);
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

test('modern HTTP validates mirrored headers including encoded Unicode and duplicates', () => {
  const body = message('tools/call', { name: '命令', arguments: {} });
  const values = {
    'mcp-protocol-version': [MODERN_VERSION],
    'mcp-method': ['tools/call'],
    'mcp-name': ['=?base64?' + Buffer.from('命令').toString('base64') + '?='],
  };
  assert.equal(
    validateModernHeaders(body, (name) => values[name] ?? []),
    null,
  );
  for (const [name, bad] of [
    ['mcp-method', []],
    ['mcp-name', ['wrong']],
    ['mcp-name', ['=?base64?!!!!?=']],
    ['mcp-protocol-version', [MODERN_VERSION, MODERN_VERSION]],
  ]) {
    const copy = { ...values, [name]: bad };
    assert.equal(validateModernHeaders(body, (key) => copy[key] ?? []).error.code, -32020);
  }
});
test('UTF8 cap measures entire escaped duplicate envelope and returns an explicit recoverable error', () => {
  const result = {
    content: [{ type: 'text', text: '😀\\'.repeat(100000) }],
    structuredContent: { text: '😀'.repeat(100000) },
    resultType: 'complete',
  };
  const bounded = boundMessage({ jsonrpc: '2.0', id: '🧪', result });
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= MCP_RESPONSE_LIMIT);
  assert.equal(bounded.result.isError, true);
  assert.match(bounded.result.content[0].text, /RESPONSE_TOO_LARGE/);
  assert.equal(bounded.result.resultType, 'complete');
});
test('fragmented large stdio frames have linear copy cost, exact bytes and no retained capacity after delivery', (t) => {
  const transport = new BridgeStdioTransport(null),
    frames = [];
  transport.line = (bytes) => frames.push(bytes.toString());
  const wire = Buffer.from(JSON.stringify({ text: '图'.repeat(2 * 1024 * 1024) }) + '\n{}\n');
  const copy = Buffer.prototype.copy,
    concat = Buffer.concat;
  let copied = 0;
  t.mock.method(Buffer.prototype, 'copy', function (...args) {
    const n = copy.apply(this, args);
    copied += n;
    return n;
  });
  t.mock.method(Buffer, 'concat', function (parts, ...args) {
    copied += parts.reduce((n, b) => n + b.length, 0);
    return concat.call(this, parts, ...args);
  });
  for (let at = 0; at < wire.length; at += 4096) transport.read(wire.subarray(at, at + 4096));
  t.mock.restoreAll();
  assert.equal(frames.join('\n') + '\n', wire.toString());
  assert.ok(copied <= wire.length * 3, { copied, wire: wire.length });
  assert.equal(transport.buffer.length, 0);
  assert.equal(transport.bufferLength, 0);
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
