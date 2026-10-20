import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createHttpService,
  loadHttpConfig,
  HTTP_BODY_LIMIT,
  TOKEN_HEADER,
} from '../src/http-server.mjs';
import { Bridge } from '../src/bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { META, MODERN_VERSION, MCP_RESPONSE_LIMIT } from '../src/protocol.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
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
    principal: 'http-fixture',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true, delete: true }],
  };
  const runtime = {
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
  };
  const bridge = await new Bridge(config, async () => runtime).init();
  const created = await savedSession(bridge, { folder_id: 'project', request_id: 'seed' });
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
    lock: path.join(config.stateDir, 'bridge.lock'),
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
test('HTTP response deadline preserves admitted work and same-ID recovery without replay', async (t) => {
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
    arguments: { session_id: f.id, request_id: 'deadline', text: 'fixture' },
  });
  const pending = request(f.url, body, { headers: modernHeaders(body) }).response;
  await entered.promise;
  const expired = await pending;
  assert.equal(expired.status, 504);
  assert.equal(expired.body.error.message, 'REQUEST_WAIT_EXPIRED');
  assert.equal(f.runtime.calls.length, 1);
  assert.equal(f.bridge.closing, undefined);
  // Exercise recovery with the normal HTTP budget, not the deliberately tiny
  // expiry budget: filesystem settlement on a loaded runner may exceed 30 ms.
  const recoveryService = createHttpService(f.bridge, { token });
  const recoveryUrl = await recoveryService.listen();
  f.cleanup.push(() => recoveryService.close());
  release.resolve();
  const recovered = await request(
    recoveryUrl,
    rpc('send', { session_id: f.id, request_id: 'deadline' }),
  ).response;
  assert.equal(recovered.status, 200, recovered.text);
  assert.equal(recovered.body.result.structuredContent.status, 'accepted');
  assert.equal(f.runtime.calls.length, 1);
});
test('HTTP measures complete Unicode MCP response including both payload representations', async (t) => {
  const f = await fixture(t);
  f.bridge.list = async () => ({ sessions: [{ text: '😀\\\\'.repeat(MCP_RESPONSE_LIMIT) }] });
  const body = modern('tools/call', { name: 'list', arguments: {} });
  const response = await request(f.url, body, { headers: modernHeaders(body) }).response;
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(response.text) <= MCP_RESPONSE_LIMIT);
  assert.equal(response.body.result.isError, true);
  assert.match(response.text, /RESPONSE_TOO_LARGE/);
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
  assert.equal((await f.call('read', { session_id: f.id })).format, 'context_timeline');
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
      await request(f.url, '', { headers: { 'Content-Length': String(HTTP_BODY_LIMIT + 1) } })
        .response
    ).status,
    413,
  );
  assert.equal(
    (await request(f.url, ' '.repeat(HTTP_BODY_LIMIT + 1), { chunked: true }).response).status,
    413,
  );
  assert.equal(
    (
      await request(f.url, '', {
        headers: { 'Content-Length': String(HTTP_BODY_LIMIT + 1), [TOKEN_HEADER]: 'wrong' },
      }).response
    ).status,
    401,
  );
  const text = '\u0000'.repeat(100000);
  assert.equal(
    (await f.call('send', { session_id: f.id, request_id: 'escaped-large', text })).status,
    'accepted',
  );
  assert.equal(f.runtime.calls[0].message.length, 100000);
  const batch = await f.call('batch', {
    operations: Array.from({ length: 10 }, (_, i) => ({
      op: 'send',
      args: { session_id: f.id, request_id: `large-batch-${i}`, text },
    })),
  });
  assert.equal(batch.status, 'processed');
  assert.equal(batch.results.length, 10);
  assert.equal(
    batch.results.every((item) => item.result.status === 'accepted'),
    true,
  );
  assert.equal(f.runtime.calls.length, 11);
});

test('same JSON-RPC IDs on concurrent HTTP requests never cross responses', async (t) => {
  const f = await fixture(t),
    both = deferred();
  let calls = 0;
  f.bridge.list = async ({ name }) => {
    if (++calls === 2) both.resolve();
    await both.promise;
    return { marker: name };
  };
  const responses = await Promise.all(
    ['first', 'second'].map((name) => request(f.url, rpc('list', { name }, 99)).response),
  );
  assert.deepEqual(
    responses.map((r) => [r.body.id, r.body.result.structuredContent.marker]),
    [
      [99, 'first'],
      [99, 'second'],
    ],
  );
});

test('lost HTTP response recovers same request_id without resend or closing Bridge', async (t) => {
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
  const original = request(
    f.url,
    rpc('send', { session_id: f.id, request_id: 'lost', text: 'fixture' }),
  );
  const lost = original.response.catch(() => null);
  await entered.promise;
  original.req.destroy();
  await lost;
  assert.equal(f.bridge.closing, undefined);
  assert.equal((await fs.stat(f.lock)).isFile(), true);
  release.resolve();
  const recovered = await f.call('send', { session_id: f.id, request_id: 'lost' });
  assert.equal(recovered.status, 'accepted');
  assert.equal(f.runtime.calls.length, 1);
  assert.equal((await f.call('list')).sessions.length, 1);
});

for (const first of ['send', 'read'])
  test(`HTTP disconnect during pending ${first} preserves later admitted batch mutations`, async (t) => {
    const f = await fixture(t),
      entered = deferred(),
      release = deferred();
    let signal, readError;
    f.cleanup.push(() => release.resolve());
    const method = first === 'send' ? 'send' : 'read',
      original = f.bridge[method].bind(f.bridge);
    f.bridge[method] = async (args, options) => {
      signal = options.signal;
      try {
        return await original(args, options);
      } catch (error) {
        readError = error;
        throw error;
      }
    };
    let initial;
    if (first === 'send') {
      f.runtime.command = async (command) => {
        f.runtime.calls.push(command);
        entered.resolve();
        await release.promise;
        return { disposition: 'started' };
      };
      initial = {
        op: 'send',
        args: { session_id: f.id, request_id: 'disconnect-send', text: 'fixture' },
      };
    } else {
      f.bridge.read = async (_args, options) => {
        signal = options.signal;
        entered.resolve();
        await new Promise((resolve, reject) => {
          if (signal.aborted) reject(new Error('READ_CANCELLED'));
          else
            signal.addEventListener('abort', () => reject(new Error('READ_CANCELLED')), {
              once: true,
            });
        }).catch((error) => {
          readError = error;
          throw error;
        });
      };
      initial = { op: 'read', args: { session_id: f.id } };
    }
    const batch = request(
      f.url,
      rpc('batch', {
        operations: [
          initial,
          {
            op: 'create',
            args: {
              project: f.config.folders[0].path,
              request_id: 'disconnect-create',
              text: 'fixture',
            },
          },
        ],
      }),
    );
    const lost = batch.response.catch(() => null);
    await entered.promise;
    assert.equal(signal.aborted, false);
    const aborted = new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    );
    batch.req.destroy();
    await lost;
    await aborted;
    release.resolve();
    await f.service.close(); // Drain the admitted tool before inspecting durable receipts.
    assert.equal((await f.bridge.journal.get('disconnect-create'))?.receipt.status, 'accepted');
    if (first === 'send') {
      assert.equal((await f.bridge.journal.get('disconnect-send')).receipt.status, 'accepted');
      assert.equal(f.runtime.calls.length, 2); // original send plus create's initial prompt
    } else assert.equal(readError?.message, 'READ_CANCELLED');
  });

test('HTTP shutdown drains admitted batch and receipt before releasing owner lock', async (t) => {
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
        { op: 'send', args: { session_id: f.id, request_id: 'drain-send', text: 'fixture' } },
        {
          op: 'create',
          args: { project: f.config.folders[0].path, request_id: 'drain-create', text: 'fixture' },
        },
      ],
    }),
  );
  const response = batch.response.catch(() => null);
  await entered.promise;
  const close = f.service.close();
  assert.equal(close, f.service.close());
  assert.equal((await fs.stat(f.lock)).isFile(), true);
  release.resolve();
  await close;
  await response;
  assert.equal((await f.bridge.journal.get('drain-send')).receipt.status, 'accepted');
  assert.equal((await f.bridge.journal.get('drain-create')).receipt.status, 'accepted');
  assert.equal(f.runtime.alive, false);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('two standard stdio proxies share one HTTP runtime and closing either preserves service and receipts', async (t) => {
  const f = await fixture(t),
    tokenFile = path.join(f.dir, 'proxy-token'),
    file = path.join(f.dir, 'proxy-owner.json');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(
    file,
    JSON.stringify({ ...f.config, http: { port: Number(new URL(f.url).port), tokenFile } }),
    { mode: 0o600 },
  );
  const clients = [];
  t.after(async () => {
    await Promise.allSettled(clients.map((client) => client.close()));
  });
  for (let index = 0; index < 2; index++) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(base, 'src/stdio-proxy.mjs'), file],
      cwd: base,
      env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'proxy-fixture-' + index, version: '1' });
    clients.push(client);
    await client.connect(transport);
  }
  const results = await Promise.all(
    clients.map((client, index) =>
      client.callTool({
        name: 'send',
        arguments: { session_id: f.id, request_id: 'proxy-' + index, text: 'fixture-' + index },
      }),
    ),
  );
  assert.ok(results.every((result) => result.structuredContent.status === 'accepted'));
  assert.equal(f.runtime.calls.length, 2);
  assert.equal(f.bridge.pool.instances.size, 1);
  await clients[0].close();
  assert.equal(f.bridge.closing, undefined);
  assert.equal((await fs.stat(f.lock)).isFile(), true);
  const recovered = await clients[1].callTool({
    name: 'send',
    arguments: { session_id: f.id, request_id: 'proxy-0' },
  });
  assert.deepEqual(recovered.structuredContent, results[0].structuredContent);
  assert.equal(f.runtime.calls.length, 2);
  assert.equal(
    (await clients[1].callTool({ name: 'list', arguments: {} })).structuredContent.sessions.length,
    1,
  );
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
  await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/);
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

test('independent HTTP CLI survives caller exit and closed stdio; SIGTERM releases its lock', async (t) => {
  const f = await fixture(t),
    port = Number(new URL(f.url).port);
  await f.service.close();
  const tokenFile = path.join(f.dir, 'backend-token'),
    file = path.join(f.dir, 'owner.json');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(file, JSON.stringify({ ...f.config, http: { port, tokenFile } }), {
    mode: 0o600,
  });
  const child = spawn(process.execPath, ['src/http-server.mjs', file], {
    cwd: base,
    env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
  });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try {
      if ((await request(f.url, initialize).response).status === 200) {
        ready = true;
        break;
      }
    } catch {}
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, stderr);
  const client = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      'await fetch(process.env.FIXTURE_URL,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","x-pi-bridge-token":process.env.FIXTURE_TOKEN},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});',
    ],
    { env: { PATH: process.env.PATH, FIXTURE_URL: f.url, FIXTURE_TOKEN: token }, stdio: 'ignore' },
  );
  const clientExit = await new Promise((resolve) => client.once('exit', resolve));
  assert.equal(clientExit, 0);
  assert.equal(child.exitCode, null);
  assert.equal((await request(f.url, rpc('list')).response).status, 200);
  child.kill('SIGTERM');
  assert.deepEqual(await done, { code: 0, signal: null }, stderr);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

for (const stage of ['before-open', 'after-open'])
  test(`HTTP startup stop waits for ${stage} lock acquisition without opening a listener`, async (t) => {
    const f = await fixture(t),
      port = Number(new URL(f.url).port);
    await f.service.close();
    const tokenFile = path.join(f.dir, 'backend-token'),
      configFile = path.join(f.dir, 'owner.json');
    const preload = path.join(f.dir, 'pause-init.mjs'),
      reached = path.join(f.dir, 'reached'),
      release = path.join(f.dir, 'release');
    await fs.writeFile(tokenFile, token, { mode: 0o600 });
    await fs.writeFile(configFile, JSON.stringify({ ...f.config, http: { port, tokenFile } }), {
      mode: 0o600,
    });
    await fs.writeFile(
      preload,
      `import fs from 'node:fs/promises';
const open=fs.open.bind(fs);
fs.open=async function(file,...args){
 if(file!==${JSON.stringify(f.lock)})return open(file,...args);
 let fd;
 if(${JSON.stringify(stage)}==='after-open')fd=await open(file,...args);
 await fs.writeFile(${JSON.stringify(reached)},'ready');
 while(!await fs.stat(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,5));
 return fd??open(file,...args);
};`,
    );
    const child = spawn(
      process.execPath,
      ['--import', preload, path.join(base, 'src/http-server.mjs'), configFile],
      {
        env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const done = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    f.cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await done;
    });
    let ready = false;
    for (let i = 0; i < 200; i++) {
      ready = await fs.stat(reached).then(
        () => true,
        () => false,
      );
      if (ready) break;
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(ready, true, stderr);
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(child.exitCode, null);
    await assert.rejects(request(f.url, initialize).response, { code: 'ECONNREFUSED' });
    await fs.writeFile(release, 'release');
    assert.deepEqual(await done, { code: 0, signal: null }, stderr);
    await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
  });
