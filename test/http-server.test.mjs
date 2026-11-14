import { ownedRuntime } from './fixtures/owned-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createHttpService } from '../src/http-server.mjs';
import { loadHttpConfig, TOKEN_HEADER } from '../src/http-config.mjs';
import { Bridge } from '../src/bridge.mjs';

import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { META, MODERN_VERSION, MCP_INPUT_LIMIT } from '../src/protocol.mjs';

const token = 'synthetic-http-test-token-never-a-real-credential';
const rpc = (name, args = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'offline-test', version: '1' },
  },
};
function request(url, message, options = {}) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  let req;
  const response = new Promise((resolve, reject) => {
    const values = {
      Host: new URL(url).host,
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      [TOKEN_HEADER]: token,
      ...options.headers,
    };
    const rawHeaders = Object.entries(values).flatMap(([name, value]) =>
      (Array.isArray(value) ? value : [value]).flatMap((item) => [name, item]),
    );
    req = http.request(
      url,
      { method: options.method ?? 'POST', headers: rawHeaders, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
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
  return { req, response };
}
async function fixture(t, serviceOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-http-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true, delete: true }],
  };
  const runtime = ownedRuntime({
    alive: true,
    calls: [],
    state: async () => ({ isStreaming: false }),
    command: async function (c) {
      this.calls.push(c);
      return { disposition: 'started' };
    },
    stop: async function () {
      this.alive = false;
    },
  });
  const bridge = await new Bridge(config, async () => runtime).init();
  const created = await savedSession(bridge);
  const service = createHttpService(bridge, { token, ...serviceOptions });
  const url = await service.listen();
  const cleanup = [];
  t.after(async () => {
    for (const fn of cleanup) await fn();
    await service.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const call = async (name, args, id) => {
    const response = await request(url, rpc(name, args, id)).response;
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.result.isError, undefined, response.text);
    return response.body.result.structuredContent;
  };
  return {
    dir,
    config,
    runtime,
    bridge,
    service,
    url,
    call,
    cleanup,
    id: created.session_id,
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const modern = (method, params = {}, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method,
  params: {
    ...params,
    _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
  },
});
const modernHeaders = (body) => ({
  'MCP-Protocol-Version': body.params._meta[META + 'protocolVersion'],
  'Mcp-Method': body.method,
  ...(body.method === 'tools/call' ? { 'Mcp-Name': body.params.name } : {}),
});
test('modern HTTP has no handshake, required discovery/meta, mirrored headers and precise version errors', async (t) => {
  const f = await fixture(t);
  for (const method of ['server/discover', 'tools/list']) {
    const body = modern(method),
      response = await request(f.url, body, { headers: modernHeaders(body) }).response;
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.result.resultType, 'complete');
    assert.equal(response.body.result.cacheScope, 'private');
    assert.equal(response.body.result.ttlMs, 0);
    assert.equal(response.headers['mcp-session-id'], undefined);
  }
  const body = modern('tools/call', { name: 'list', arguments: {} });
  const success = await request(f.url, body, { headers: modernHeaders(body) }).response;
  assert.equal(success.status, 200);
  assert.equal(success.body.result.structuredContent.sessions[0].session_id, f.id);
  for (const bad of [
    { 'Mcp-Method': 'tools/list' },
    { 'Mcp-Name': 'read' },
    { 'Mcp-Method': ['tools/call', 'tools/call'] },
  ]) {
    const response = await request(f.url, body, { headers: { ...modernHeaders(body), ...bad } })
      .response;
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, -32020);
  }
  const unsupported = modern('tools/list');
  unsupported.params._meta[META + 'protocolVersion'] = '2099-01-01';
  const response = await request(f.url, unsupported, { headers: modernHeaders(unsupported) })
    .response;
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, -32022);
  assert.equal(response.body.error.data.requested, '2099-01-01');
  const missing = modern('tools/list');
  delete missing.params._meta[META + 'clientCapabilities'];
  const malformed = await request(f.url, missing, { headers: modernHeaders(missing) }).response;
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, -32602);
  const unknown = modern('unknown/method');
  const notFound = await request(f.url, unknown, { headers: modernHeaders(unknown) }).response;
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, -32601);
});
test('HTTP response deadline reports uncertainty and does not replay admitted work', async (t) => {
  const f = await fixture(t, { waitTimeoutMs: 30 }),
    entered = deferred(),
    release = deferred();
  f.cleanup.push(() => release.resolve());
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
  const pending = request(f.url, body, { headers: modernHeaders(body) }).response;
  await entered.promise;
  const expired = await pending;
  assert.equal(expired.status, 504);
  assert.equal(expired.body.error.message, 'REQUEST_WAIT_EXPIRED');
  assert.equal(f.runtime.calls.length, 1);
  assert.equal(f.bridge.closing, undefined);
  assert.match(JSON.stringify(expired.body), /OUTCOME_UNKNOWN/);
  release.resolve();
  await Promise.allSettled([...f.bridge.pendingMutations]);
  assert.equal(f.runtime.calls.length, 1);
});

test('HTTP initialize and independent requests use JSON without MCP sessions or SSE', async (t) => {
  const f = await fixture(t);
  const response = await request(f.url, initialize).response;
  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, '2025-11-25');
  assert.equal(response.headers['mcp-session-id'], undefined);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.call('list')).sessions[0].session_id, f.id);
  assert.equal((await f.call('read', { session_id: f.id })).session_id, f.id);
  for (const method of ['GET', 'DELETE', 'OPTIONS'])
    assert.equal((await request(f.url, '', { method }).response).status, 405);
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
    const response = await request(f.url, '{bad json', { headers }).response;
    assert.equal(response.status, status, JSON.stringify(headers));
    assert.equal(response.text.includes(token), false);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const noAuth = await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{bad json');
  });
  assert.equal(noAuth, 401);
  assert.equal((await request(f.url, '{bad json').response).status, 400);
  assert.equal((await request(f.url, [rpc('list')]).response).status, 400);
  assert.equal(
    (await request(f.url, rpc('list'), { headers: { 'Content-Encoding': 'gzip' } }).response)
      .status,
    415,
  );
  assert.equal(
    (
      await request(f.url, rpc('list'), { headers: { 'MCP-Protocol-Version': '2026-07-28' } })
        .response
    ).status,
    400,
  );
});

test('HTTP bounds declared and chunked bodies and accepts ten maximally escaped prompts', async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await request(f.url, '', { headers: { 'Content-Length': String(MCP_INPUT_LIMIT + 1) } })
        .response
    ).status,
    413,
  );
  assert.equal(
    (await request(f.url, ' '.repeat(MCP_INPUT_LIMIT + 1), { chunked: true }).response).status,
    413,
  );
  assert.equal(
    (
      await request(f.url, '', {
        headers: { 'Content-Length': String(MCP_INPUT_LIMIT + 1), [TOKEN_HEADER]: 'wrong' },
      }).response
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
  f.cleanup.push(() => release.resolve());
  const batch = request(
    f.url,
    rpc('batch', {
      operations: [
        { op: 'send', args: { session_id: f.id, text: 'fixture' } },
        {
          op: 'create',
          args: { project: f.config.folders[0].path, fork_from: f.id, text: 'fixture' },
        },
      ],
    }),
  );
  const response = batch.response.catch(() => null);
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
