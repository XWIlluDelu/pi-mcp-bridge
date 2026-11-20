import { readLfLines } from '../src/core/lf-lines.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createStdioProxy } from '../src/stdio-proxy.mjs';
import { META, MODERN_VERSION } from '../src/mcp/protocol.mjs';

const token = 'synthetic-proxy-token-never-a-real-credential';
function fixture(fetchImpl, port = 43123) {
  const input = new PassThrough(),
    output = new PassThrough(),
    lines = [];
  readLfLines(output, (line) => lines.push(JSON.parse(line)));
  const proxy = createStdioProxy({
    port,
    token,
    input,
    output,
    fetchImpl,
  });
  const send = (id, method, params) =>
    input.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
        },
      }) + '\n',
    );
  return { input, lines, proxy, send };
}
test('stdio proxy forwards per-request metadata and encodes the mirrored tool name', async () => {
  const received = [];
  const f = fixture(async (url, options) => {
    const body = JSON.parse(options.body);
    received.push({ url: String(url), headers: options.headers, body });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { marker: body.method } }),
      { headers: { 'content-type': 'application/json' } },
    );
  }, 80);
  await f.proxy.start();
  f.send(1, 'tools/call', {
    name: '命令',
    arguments: {},
  });
  await f.proxy.drain();
  assert.equal(received.length, 1);
  assert.equal(received[0].url, 'http://127.0.0.1/mcp');
  const headers = new Headers(received[0].headers);
  assert.equal(headers.get('mcp-protocol-version'), MODERN_VERSION);
  assert.equal(headers.get('mcp-method'), 'tools/call');
  assert.match(headers.get('mcp-name'), /^=\?base64\?/);
  assert.deepEqual(f.lines, [{ jsonrpc: '2.0', id: 1, result: { marker: 'tools/call' } }]);
  await f.proxy.close();
});
test('proxy preserves exact backend rejections as not admitted without retrying input', async (t) => {
  for (const [status, code] of [
    [401, 'UNAUTHORIZED'],
    [413, 'BODY_TOO_LARGE'],
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
      f.send(7, 'tools/call', { name: 'send', arguments: {} });
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
    });
});

test('proxy reports a lost connection once, never resubmits a mutation, and close aborts only its request', async () => {
  let count = 0;
  const f = fixture(async () => {
    count++;
    throw new Error('network');
  });
  await f.proxy.start();
  f.send(7, 'tools/call', { name: 'send', arguments: {} });
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
  blocked.send(8, 'ping');
  await blocked.proxy.close();
  await blocked.proxy.drain();
  assert.equal(blocked.lines.length, 0);
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
  for (let id = 1; id <= 40; id++) f.send(id, 'ping');
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
  f.send(41, 'ping');
  await f.proxy.drain();
  assert.equal(forwarded, 17);
  assert.deepEqual(f.lines.at(-1), { jsonrpc: '2.0', id: 41, result: {} });
});
