import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createStdioProxy } from '../src/stdio-proxy.mjs';
import { META, MODERN_VERSION } from '../src/protocol.mjs';

const token = 'synthetic-proxy-token-never-a-real-credential';
function fixture(fetchImpl) {
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
  const proxy = createStdioProxy({
    url: 'http://127.0.0.1:43123/mcp',
    token,
    input,
    output,
    fetchImpl,
  });
  return { input, lines, proxy };
}
test('stdio proxy forwards modern metadata and SDK initialization without runtime or retry', async () => {
  const received = [];
  const f = fixture(async (url, options) => {
    const body = JSON.parse(options.body);
    received.push({ url: String(url), headers: options.headers, body });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { marker: body.method } }),
      { headers: { 'content-type': 'application/json' } },
    );
  });
  await f.proxy.start();
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: '命令',
      arguments: {},
      _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
    },
  };
  f.input.write(JSON.stringify(body) + '\n');
  f.input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    }) + '\n',
  );
  await f.proxy.drain();
  assert.equal(received.length, 2);
  assert.equal(received[0].headers['MCP-Protocol-Version'], MODERN_VERSION);
  assert.equal(received[0].headers['Mcp-Method'], 'tools/call');
  assert.match(received[0].headers['Mcp-Name'], /^=\?base64\?/);
  assert.equal(received[1].headers['Mcp-Method'], undefined);
  assert.deepEqual(
    f.lines.map((x) => x.id),
    [1, 2],
  );
  await f.proxy.close();
});
test('proxy preserves exact backend rejections as not admitted without retrying input', async (t) => {
  for (const [status, code] of [
    [400, 'INVALID_JSON_OBJECT'],
    [401, 'UNAUTHORIZED'],
    [403, 'INVALID_HOST'],
    [403, 'ORIGIN_DENIED'],
    [404, 'NOT_FOUND'],
    [405, 'METHOD_NOT_ALLOWED'],
    [413, 'BODY_TOO_LARGE'],
    [415, 'UNSUPPORTED_CONTENT_TYPE'],
    [503, 'SERVICE_STOPPING'],
    [503, 'SERVICE_BUSY'],
  ])
    await t.test(`${status} ${code}`, async (t) => {
      let forwards = 0;
      const f = fixture(async () => {
        forwards++;
        return new Response(JSON.stringify({ error: code }), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      });
      t.after(() => f.proxy.close());
      await f.proxy.start();
      f.input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'send', arguments: {} },
        }) + '\n',
      );
      await f.proxy.drain();
      assert.equal(forwards, 1);
      assert.deepEqual(f.lines, [
        {
          jsonrpc: '2.0',
          id: 7,
          error: {
            code: -32000,
            message: code,
            data: { http_status: status, recovery: 'NOT_ADMITTED' },
          },
        },
      ]);
      f.input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      await f.proxy.drain();
      assert.equal(forwards, 2);
      assert.equal(f.lines.length, 1, 'rejected notifications receive no JSON-RPC response');
    });
});
test('proxy keeps unverified backend failures unknown without retrying input', async (t) => {
  for (const [name, status, response, contentType = 'application/json'] of [
    ['server failure', 500, { error: 'REQUEST_FAILED' }],
    ['timeout', 504, { error: 'REQUEST_WAIT_EXPIRED' }],
    ['wrong status', 400, { error: 'UNAUTHORIZED' }],
    ['known reason in server failure', 500, { error: 'SERVICE_BUSY' }],
    ['known reason in timeout', 504, { error: 'SERVICE_BUSY' }],
    ['unknown reason', 503, { error: 'ARBITRARY_BACKEND_DETAIL' }],
    ['extra fields', 401, { error: 'UNAUTHORIZED', result: 'possibly admitted' }],
    ['non-string reason', 401, { error: { code: 'UNAUTHORIZED' } }],
    ['null body', 401, null],
    ['array body', 401, [{ error: 'UNAUTHORIZED' }]],
    ['non-JSON content type', 401, { error: 'UNAUTHORIZED' }, 'text/plain'],
  ])
    await t.test(name, async (t) => {
      let forwards = 0;
      const f = fixture(async () => {
        forwards++;
        return new Response(JSON.stringify(response), {
          status,
          headers: { 'content-type': contentType },
        });
      });
      t.after(() => f.proxy.close());
      await f.proxy.start();
      f.input.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'send', arguments: {} },
        }) + '\n',
      );
      await f.proxy.drain();
      assert.equal(forwards, 1);
      assert.equal(f.lines.length, 1);
      assert.equal(f.lines[0].error.message, 'BRIDGE_CONNECTION_LOST');
      assert.match(f.lines[0].error.data.recovery, /OUTCOME_UNKNOWN/);
      assert.doesNotMatch(JSON.stringify(f.lines), /NOT_ADMITTED|ARBITRARY_BACKEND_DETAIL/);
    });
});
test('proxy preserves a correlated backend wait-expired response and its unknown outcome', async (t) => {
  const response = {
    jsonrpc: '2.0',
    id: 7,
    error: {
      code: -32000,
      message: 'REQUEST_WAIT_EXPIRED',
      data: { recovery: 'OUTCOME_UNKNOWN; timeout does not stop submitted Pi work.' },
    },
  };
  let forwards = 0;
  const f = fixture(async () => {
    forwards++;
    return new Response(JSON.stringify(response), {
      status: 504,
      headers: { 'content-type': 'application/json' },
    });
  });
  t.after(() => f.proxy.close());
  await f.proxy.start();
  f.input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'send', arguments: {} },
    }) + '\n',
  );
  await f.proxy.drain();
  assert.equal(forwards, 1);
  assert.deepEqual(f.lines, [response]);
});
test('proxy reports a lost connection once, never resubmits a mutation, and close aborts only its request', async () => {
  let count = 0;
  const f = fixture(async () => {
    count++;
    throw new Error('network');
  });
  await f.proxy.start();
  f.input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'send', arguments: {} },
    }) + '\n',
  );
  await f.proxy.drain();
  assert.equal(count, 1);
  assert.equal(f.lines[0].error.message, 'BRIDGE_CONNECTION_LOST');
  assert.match(JSON.stringify(f.lines), /OUTCOME_UNKNOWN/);
  await f.proxy.close();
  const blocked = fixture(
    async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  );
  await blocked.proxy.start();
  blocked.input.write(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping' }) + '\n');
  await blocked.proxy.close();
  await blocked.proxy.drain();
  assert.equal(blocked.lines.length, 0);
});
test('concurrent notifications have no duplicate-ID response and requests remain independently cancellable', async (t) => {
  const pending = [];
  const f = fixture(
    async (_url, { body, signal }) =>
      new Promise((resolve, reject) => {
        pending.push({ body: JSON.parse(body), resolve, signal });
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  );
  t.after(async () => {
    await f.proxy.close();
    await f.proxy.drain();
  });
  await f.proxy.start();
  for (const method of ['notifications/initialized', 'notifications/roots/list_changed'])
    f.input.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) + '\n');
  assert.equal(pending.length, 3);
  f.input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 1 },
    }) + '\n',
  );
  assert.equal(pending[2].signal.aborted, true);
  assert.equal(pending[0].signal.aborted, false);
  assert.equal(pending[1].signal.aborted, false);
  for (const p of pending.slice(0, 2)) p.resolve(new Response(null, { status: 202 }));
  await f.proxy.drain();
  assert.deepEqual(f.lines, []);
});
test('proxy bounds outstanding HTTP requests, never queues rejected work and resumes after drain', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  let forwarded = 0;
  const f = fixture(async (_url, { body }) => {
    forwarded++;
    await gate;
    const { id } = JSON.parse(body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: {} }), {
      headers: { 'content-type': 'application/json' },
    });
  });
  t.after(async () => {
    release();
    await f.proxy.close();
    await f.proxy.drain();
  });
  await f.proxy.start();
  for (let id = 1; id <= 40; id++)
    f.input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' }) + '\n');
  assert.equal(forwarded, 16);
  release();
  await f.proxy.drain();
  assert.equal(f.lines.filter((r) => r.result).length, 16);
  const rejected = f.lines.filter((r) => r.error);
  assert.equal(rejected.length, 24);
  assert.ok(
    rejected.every(
      (r) => r.error.message === 'PROXY_BUSY' && r.error.data.recovery === 'NOT_FORWARDED',
    ),
  );
  f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 41, method: 'ping' }) + '\n');
  await f.proxy.drain();
  assert.equal(forwarded, 17);
  assert.deepEqual(f.lines.at(-1), { jsonrpc: '2.0', id: 41, result: {} });
});
test('proxy rejects non-loopback targets and never forwards malformed JSON', async () => {
  assert.throws(
    () => createStdioProxy({ url: 'http://example.com:43123/mcp', token }),
    /INVALID_PROXY_URL/,
  );
  let count = 0;
  const f = fixture(async () => {
    count++;
  });
  await f.proxy.start();
  f.input.write('{bad json\n');
  await f.proxy.drain();
  assert.equal(count, 0);
  assert.equal(f.lines[0].error.code, -32700);
  for (const params of [null, [], 'invalid'])
    f.input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params }) + '\n');
  await f.proxy.drain();
  assert.equal(count, 0);
  assert.ok(f.lines.slice(1).every((r) => r.error.code === -32600));
  await f.proxy.close();
});
