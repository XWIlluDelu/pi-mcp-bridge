import { mcpRequest as modern } from './fixtures/tool-call.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';

import path from 'node:path';

import { createHttpService } from '../src/http-server.mjs';
import { loadHttpConfig, TOKEN_HEADER } from '../src/mcp/http-config.mjs';

import { META, MCP_INPUT_LIMIT } from '../src/mcp/protocol.mjs';

const token = 'synthetic-http-test-token-never-a-real-credential';
const rpc = (name, args = {}) => modern('tools/call', { name, arguments: args });
function request(url, message, options = {}) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  return new Promise((resolve, reject) => {
    const values = {
      Host: new URL(url).host,
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: token,
      ...(message?.params?._meta ? modernHeaders(message) : {}),
      ...options.headers,
    };
    const rawHeaders = Object.entries(values).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item]),
    );
    const req = http.request(
      url,
      { method: options.method ?? 'POST', headers: rawHeaders, agent: false },
      (res) => {
        res.setEncoding('utf8');
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            body: text ? JSON.parse(text) : null,
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    if (options.chunked) {
      req.write(body);
      req.end();
    } else req.end(body);
  });
}
async function fixture(t, serviceOptions = {}) {
  const runtime = ownedRuntime({
    calls: [],
    state: async () => ({ isStreaming: false }),
    command: async function (c) {
      this.calls.push(c);
      return { disposition: 'started' };
    },
  });
  const f = await nativeOwner(t, { prefix: 'http', factory: async () => runtime });
  const service = createHttpService(f.bridge, { token, ...serviceOptions });
  f.cleanup.push(() => service.close());
  const url = await service.listen();
  const call = async (name, args) => {
    const response = await request(url, rpc(name, args));
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.result.isError, undefined, response.text);
    return response.body.result.structuredContent;
  };
  return { ...f, runtime, service, url, call };
}
const deferred = () => Promise.withResolvers();

const modernHeaders = (body) => ({
  'MCP-Protocol-Version': body.params._meta[META + 'protocolVersion'],
  'Mcp-Method': body.method,
  ...(body.method === 'tools/call' ? { 'Mcp-Name': body.params.name } : {}),
});
test('HTTP accepts matching per-request headers and rejects mismatches or duplicates', async (t) => {
  const f = await fixture(t);
  const body = modern('tools/call', { name: 'list_sessions', arguments: {} });
  const success = await request(f.url, body);
  assert.equal(success.status, 200);
  assert.equal(success.headers['mcp-session-id'], undefined);
  assert.equal(success.body.result.structuredContent.sessions[0].session_id, f.id);
  for (const bad of [
    { 'Mcp-Method': 'tools/list' },
    { 'Mcp-Name': 'read' },
    { 'MCP-Protocol-Version': '2025-11-25' },
    { 'Mcp-Method': ['tools/call', 'tools/call'] },
  ]) {
    const response = await request(f.url, body, { headers: bad });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32020);
  }
  const initialize = await request(f.url, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  });
  assert.equal(initialize.status, 200);
  assert.equal(initialize.body.result.protocolVersion, '2025-11-25');
  assert.equal((await request(f.url, '', { method: 'DELETE' })).status, 204);
  for (const method of ['GET', 'OPTIONS'])
    assert.equal((await request(f.url, '', { method })).status, 405);
});
test('HTTP response deadline reports uncertainty and does not replay admitted work', async (t) => {
  const f = await fixture(t, { waitTimeoutMs: 30 }),
    entered = deferred(),
    release = deferred();
  f.cleanup.unshift(() => release.resolve());
  f.runtime.command = async (command) => {
    f.runtime.calls.push(command);
    entered.resolve();
    await release.promise;
    return { disposition: 'started' };
  };
  const body = modern('tools/call', {
    name: 'send',
    arguments: { session_id: f.id, text: 'fixture' },
  });
  const pending = request(f.url, body);
  await entered.promise;
  const expired = await pending;
  assert.equal(expired.status, 504);
  assert.equal(expired.body.error.message, 'REQUEST_WAIT_EXPIRED');
  assert.equal(f.runtime.calls.length, 1);
  assert.equal(f.bridge.closing, undefined);
  assert.match(JSON.stringify(expired.body), /OUTCOME_UNKNOWN/);
  release.resolve();
  await Promise.allSettled(f.bridge.mutations.values().map((mutation) => mutation.work));
  assert.equal(f.runtime.calls.length, 1);
});

test('HTTP enforces exact Host, denies every Origin, and authenticates before parsing', async (t) => {
  const f = await fixture(t),
    host = new URL(f.url).host;
  const cases = [
    [{ Host: 'evil.invalid' }, 403],
    [{ Host: 'localhost:' + new URL(f.url).port }, 403],
    [{ Host: [host, host] }, 403],
    [{ Origin: 'http://' + host }, 403],
    [{ Origin: '' }, 403],
    [{ [TOKEN_HEADER]: '' }, 401],
    [{ [TOKEN_HEADER]: 'incorrect-synthetic-value' }, 401],
    [{ [TOKEN_HEADER]: [token, token] }, 401],
  ];
  for (const [headers, status] of cases) {
    const response = await request(f.url, '{bad json', { headers });
    assert.equal(response.status, status, JSON.stringify(headers));
    assert.equal(response.text.includes(token), false);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  for (const [body, headers, status] of [
    ['{bad json', {}, 400],
    [[rpc('list_sessions')], {}, 400],
    [rpc('list_sessions'), { 'Content-Encoding': 'gzip' }, 415],
    [{ jsonrpc: '2.0', id: 1, method: 'server/discover' }, {}, 400],
  ])
    assert.equal((await request(f.url, body, { headers })).status, status);
});

test('HTTP bounds declared and chunked bodies and accepts ten maximally escaped prompts', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await request(f.url, '', { headers: { 'Content-Length': String(MCP_INPUT_LIMIT + 1) } }))
      .status,
    413,
  );
  assert.equal(
    (await request(f.url, ' '.repeat(MCP_INPUT_LIMIT + 1), { chunked: true })).status,
    413,
  );
  assert.equal(
    (
      await request(f.url, '', {
        headers: { 'Content-Length': String(MCP_INPUT_LIMIT + 1), [TOKEN_HEADER]: 'wrong' },
      })
    ).status,
    401,
  );
  const text = '\u0000'.repeat(100000);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (await f.call('send', { session_id: f.id, text })).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal(f.runtime.calls[0].message.length, 100000);
  const batch = await f.call('batch', {
    operations: Array.from({ length: 10 }, (_, i) => ({
      op: 'send',
      args: { session_id: f.id, text },
    })),
  });
  assert.equal(batch.status, 'processed');
  assert.equal(batch.results.length, 10);
  assert.equal(
    batch.results.every((item) => item.result.status === 'started'),
    true,
  );
  assert.equal(f.runtime.calls.length, 11);
});

test('HTTP shutdown drains input ACKs without publishing a later batch create', async (t) => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  f.runtime.command = async (command) => {
    f.runtime.calls.push(command);
    entered.resolve();
    await release.promise;
    return { disposition: 'started' };
  };
  f.cleanup.unshift(() => release.resolve());
  const batch = request(
    f.url,
    rpc('batch', {
      operations: [
        { op: 'send', args: { session_id: f.id, text: 'fixture' } },
        {
          op: 'create_session',
          args: { project: f.config.folders[0].path, fork_from: f.id, text: 'fixture' },
        },
      ],
    }),
  );
  const response = batch.catch(() => null);
  await entered.promise;
  const close = f.service.close();
  assert.equal(close, f.service.close());
  assert.ok(f.bridge.lock);
  release.resolve();
  await close;
  const results = (await response).body.result.structuredContent.results;
  assert.equal(results[0].result.status, 'started');
  assert.equal(results[1].error.code, 'BRIDGE_CLOSING');
  assert.equal((await f.bridge.sessions()).length, 1);
  assert.equal(f.runtime.alive, false);
});

test('HTTP owner configuration requires canonical private token and config files', async (t) => {
  const f = await fixture(t),
    tokenFile = path.join(f.dir, 'backend-token'),
    file = path.join(f.dir, 'owner.json');
  await fs.writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const config = { ...f.config, http: { port: 43125, tokenFile } };
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await loadHttpConfig(file)).token, token);
  await fs.chmod(tokenFile, 0o644);
  await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/);
  await fs.chmod(tokenFile, 0o600);
  await fs.chmod(file, 0o644);
  assert.equal((await loadHttpConfig(file)).token, token);
  const configLink = path.join(f.dir, 'owner-link.json');
  await fs.symlink(file, configLink);
  assert.equal((await loadHttpConfig(configLink)).token, token);
  await fs.chmod(file, 0o666);
  await assert.rejects(loadHttpConfig(file), /OWNER_CONFIG_NOT_PRIVATE/);
  await fs.chmod(file, 0o600);
  const link = path.join(f.dir, 'token-link');
  await fs.symlink(tokenFile, link);
  await fs.writeFile(
    file,
    JSON.stringify({ ...config, http: { ...config.http, tokenFile: link } }),
  );
  await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/);
  await fs.writeFile(
    file,
    JSON.stringify({ ...config, http: { ...config.http, host: '0.0.0.0' } }),
  );
  await assert.rejects(loadHttpConfig(file), /INVALID_HTTP_CONFIG/);
});
