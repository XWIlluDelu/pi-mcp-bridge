import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHttpService, loadHttpConfig, HTTP_BODY_LIMIT, TOKEN_HEADER } from '../src/http-server.mjs';
import { Bridge } from '../src/bridge.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const token = 'synthetic-http-test-token-never-a-real-credential';
const rpc = (name, args = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1' } } };
function request(url, message, options = {}) {
  const body = typeof message === 'string' ? message : JSON.stringify(message);
  let req;
  const response = new Promise((resolve, reject) => {
    const values = { Host: new URL(url).host,
      Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json', [TOKEN_HEADER]: token,
      ...options.headers,
    };
    const rawHeaders = Object.entries(values).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).flatMap(item => [name, item]));
    req = http.request(url, { method: options.method ?? 'POST', headers: rawHeaders, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        resolve({ status: res.statusCode, headers: res.headers, text, body: text ? JSON.parse(text) : null });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.chunked) { req.write(body); req.end(); } else req.end(body);
  });
  return { req, response };
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-http-')), cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = { principal: 'http-fixture', stateDir: path.join(dir, 'state'), sessionRoots: [path.join(dir, 'sessions')], folders: [{ id: 'project', path: cwd }], grants: [{ folder: cwd, read: true, send: true, new_session: true, delete: true }] };
  const runtime = { alive: true, calls: [], state: async () => ({ isStreaming: false }), command: async function(c) { this.calls.push(c); return { disposition: 'started' }; }, stop: async function() { this.alive = false; } };
  const bridge = await new Bridge(config, async () => runtime).init();
  const created = await bridge.create({ folder_id: 'project', request_id: 'seed' });
  const service = createHttpService(bridge, { token });
  const url = await service.listen();
  const cleanup = [];
  t.after(async () => { for (const fn of cleanup) await fn(); await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const call = async (name, args, id) => {
    const response = await request(url, rpc(name, args, id)).response;
    assert.equal(response.status, 200, response.text);
    assert.equal(response.body.result.isError, undefined, response.text);
    return response.body.result.structuredContent;
  };
  return { dir, config, runtime, bridge, service, url, call, cleanup, id: created.session_id, lock: path.join(config.stateDir, 'bridge.lock') };
}
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('HTTP initialize and independent requests use JSON without MCP sessions or SSE', async t => {
  const f = await fixture(t);
  const response = await request(f.url, initialize).response;
  assert.equal(response.status, 200);
  assert.equal(response.body.result.protocolVersion, '2025-11-25');
  assert.equal(response.headers['mcp-session-id'], undefined);
  assert.match(response.headers['content-type'], /application\/json/);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal((await f.call('list')).sessions[0].session_id, f.id);
  assert.equal((await f.call('read', { session_id: f.id, view: 'raw' })).view, 'raw');
  assert.equal((await f.call('read', { session_id: f.id })).view, 'context');
  for (const method of ['GET', 'DELETE', 'OPTIONS']) assert.equal((await request(f.url, '', { method }).response).status, 405);
});

test('HTTP enforces exact Host, denies every Origin, and authenticates before parsing', async t => {
  const f = await fixture(t), host = new URL(f.url).host;
  const cases = [
    [{ Host: 'evil.invalid' }, 403], [{ Host: 'localhost:' + new URL(f.url).port }, 403],
    [{ Host: [host, host] }, 403], [{ Origin: 'http://' + host }, 403], [{ Origin: '' }, 403],
    [{ [TOKEN_HEADER]: '' }, 401], [{ [TOKEN_HEADER]: 'incorrect-synthetic-value' }, 401],
    [{ [TOKEN_HEADER]: [token, token] }, 401],
  ];
  for (const [headers, status] of cases) {
    const response = await request(f.url, '{bad json', { headers }).response;
    assert.equal(response.status, status, JSON.stringify(headers));
    assert.equal(response.text.includes(token), false);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  const noAuth = await new Promise((resolve, reject) => {
    const req = http.request(f.url, { method: 'POST' }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end('{bad json');
  });
  assert.equal(noAuth, 401);
  assert.equal((await request(f.url, '{bad json').response).status, 400);
  assert.equal((await request(f.url, [rpc('list')]).response).status, 400);
  assert.equal((await request(f.url, rpc('list'), { headers: { 'Content-Encoding': 'gzip' } }).response).status, 415);
  assert.equal((await request(f.url, rpc('list'), { headers: { 'MCP-Protocol-Version': '2026-07-28' } }).response).status, 400);
});

test('HTTP bounds declared and chunked bodies and accepts ten maximally escaped prompts', async t => {
  const f = await fixture(t);
  assert.equal((await request(f.url, '', { headers: { 'Content-Length': String(HTTP_BODY_LIMIT + 1) } }).response).status, 413);
  assert.equal((await request(f.url, ' '.repeat(HTTP_BODY_LIMIT + 1), { chunked: true }).response).status, 413);
  assert.equal((await request(f.url, '', { headers: { 'Content-Length': String(HTTP_BODY_LIMIT + 1), [TOKEN_HEADER]: 'wrong' } }).response).status, 401);
  const text = '\u0000'.repeat(100000);
  assert.equal((await f.call('send', { session_id: f.id, request_id: 'escaped-large', text })).status, 'accepted');
  assert.equal(f.runtime.calls[0].message.length, 100000);
  const batch = await f.call('batch', { operations: Array.from({ length: 10 }, (_, i) => ({
    op: 'send', args: { session_id: f.id, request_id: `large-batch-${i}`, text },
  })) });
  assert.equal(batch.status, 'processed');
  assert.equal(batch.results.length, 10);
  assert.equal(batch.results.every(item => item.result.status === 'accepted'), true);
  assert.equal(f.runtime.calls.length, 11);
});

test('same JSON-RPC IDs on concurrent HTTP requests never cross responses', async t => {
  const f = await fixture(t), both = deferred(); let calls = 0;
  f.bridge.list = async ({ query }) => { if (++calls === 2) both.resolve(); await both.promise; return { marker: query }; };
  const responses = await Promise.all(['first', 'second'].map(query => request(f.url, rpc('list', { query }, 99)).response));
  assert.deepEqual(responses.map(r => [r.body.id, r.body.result.structuredContent.marker]), [[99, 'first'], [99, 'second']]);
});

test('lost HTTP response recovers same request_id without resend or closing Bridge', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.runtime.command = async command => { f.runtime.calls.push(command); entered.resolve(); await release.promise; return { disposition: 'started' }; };
  f.cleanup.push(() => release.resolve());
  const original = request(f.url, rpc('send', { session_id: f.id, request_id: 'lost', text: 'fixture' }));
  const lost = original.response.catch(() => null);
  await entered.promise;
  original.req.destroy(); await lost;
  assert.equal(f.bridge.closing, undefined);
  assert.equal((await fs.stat(f.lock)).isFile(), true);
  release.resolve();
  const recovered = await f.call('send', { session_id: f.id, request_id: 'lost' });
  assert.equal(recovered.status, 'accepted'); assert.equal(f.runtime.calls.length, 1);
  assert.equal((await f.call('list')).sessions.length, 1);
});

test('HTTP shutdown drains admitted batch and receipt before releasing owner lock', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.runtime.command = async command => { f.runtime.calls.push(command); entered.resolve(); await release.promise; return { disposition: 'started' }; };
  f.cleanup.push(() => release.resolve());
  const batch = request(f.url, rpc('batch', { operations: [
    { op: 'send', args: { session_id: f.id, request_id: 'drain-send', text: 'fixture' } },
    { op: 'create', args: { folder_id: 'project', request_id: 'drain-create' } },
  ] }));
  const response = batch.response.catch(() => null);
  await entered.promise;
  const close = f.service.close();
  assert.equal(close, f.service.close());
  assert.equal((await fs.stat(f.lock)).isFile(), true);
  release.resolve(); await close; await response;
  assert.equal((await f.bridge.journal.get('drain-send')).receipt.status, 'accepted');
  assert.equal((await f.bridge.journal.get('drain-create')).receipt.status, 'created');
  assert.equal(f.runtime.alive, false);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

test('HTTP owner configuration requires canonical private token and config files', async t => {
  const f = await fixture(t), tokenFile = path.join(f.dir, 'backend-token'), file = path.join(f.dir, 'owner.json');
  await fs.writeFile(tokenFile, token + '\n', { mode: 0o600 });
  const config = { ...f.config, http: { port: 43125, tokenFile } };
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  assert.equal((await loadHttpConfig(file)).token, token);
  await fs.chmod(tokenFile, 0o644); await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/); await fs.chmod(tokenFile, 0o600);
  await fs.chmod(file, 0o644); await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/); await fs.chmod(file, 0o600);
  const link = path.join(f.dir, 'token-link'); await fs.symlink(tokenFile, link);
  await fs.writeFile(file, JSON.stringify({ ...config, http: { ...config.http, tokenFile: link } }));
  await assert.rejects(loadHttpConfig(file), /INVALID_PRIVATE_FILE/);
  await fs.writeFile(file, JSON.stringify({ ...config, http: { ...config.http, host: '0.0.0.0' } }));
  await assert.rejects(loadHttpConfig(file), /INVALID_HTTP_CONFIG/);
});

test('independent HTTP CLI survives caller exit and closed stdio; SIGTERM releases its lock', async t => {
  const f = await fixture(t), port = Number(new URL(f.url).port);
  await f.service.close();
  const tokenFile = path.join(f.dir, 'backend-token'), file = path.join(f.dir, 'owner.json');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(file, JSON.stringify({ ...f.config, http: { port, tokenFile } }), { mode: 0o600 });
  const child = spawn(process.execPath, ['src/http-server.mjs', file], { cwd: base, env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    try { if ((await request(f.url, initialize).response).status === 200) { ready = true; break; } } catch {}
    if (child.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, stderr);
  const client = spawn(process.execPath, ['--input-type=module', '-e', 'await fetch(process.env.FIXTURE_URL,{method:"POST",headers:{"content-type":"application/json",accept:"application/json, text/event-stream","x-pi-bridge-token":process.env.FIXTURE_TOKEN},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/list"})});'], { env: { PATH: process.env.PATH, FIXTURE_URL: f.url, FIXTURE_TOKEN: token }, stdio: 'ignore' });
  const clientExit = await new Promise(resolve => client.once('exit', resolve)); assert.equal(clientExit, 0);
  assert.equal(child.exitCode, null);
  assert.equal((await request(f.url, rpc('list')).response).status, 200);
  child.kill('SIGTERM');
  assert.deepEqual(await done, { code: 0, signal: null }, stderr);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});

for (const stage of ['before-open', 'after-open']) test(`HTTP startup stop waits for ${stage} lock acquisition without opening a listener`, async t => {
  const f = await fixture(t), port = Number(new URL(f.url).port);
  await f.service.close();
  const tokenFile = path.join(f.dir, 'backend-token'), configFile = path.join(f.dir, 'owner.json');
  const preload = path.join(f.dir, 'pause-init.mjs'), reached = path.join(f.dir, 'reached'), release = path.join(f.dir, 'release');
  await fs.writeFile(tokenFile, token, { mode: 0o600 });
  await fs.writeFile(configFile, JSON.stringify({ ...f.config, http: { port, tokenFile } }), { mode: 0o600 });
  await fs.writeFile(preload, `import fs from 'node:fs/promises';
const open=fs.open.bind(fs);
fs.open=async function(file,...args){
 if(file!==${JSON.stringify(f.lock)})return open(file,...args);
 let fd;
 if(${JSON.stringify(stage)}==='after-open')fd=await open(file,...args);
 await fs.writeFile(${JSON.stringify(reached)},'ready');
 while(!await fs.stat(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,5));
 return fd??open(file,...args);
};`);
  const child = spawn(process.execPath, ['--import', preload, path.join(base, 'src/http-server.mjs'), configFile], { env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  f.cleanup.push(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; });
  let ready = false;
  for (let i = 0; i < 200; i++) {
    ready = await fs.stat(reached).then(() => true, () => false); if (ready) break;
    if (child.exitCode !== null) break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(ready, true, stderr);
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(child.exitCode, null);
  await assert.rejects(request(f.url, initialize).response, { code: 'ECONNREFUSED' });
  await fs.writeFile(release, 'release');
  assert.deepEqual(await done, { code: 0, signal: null }, stderr);
  await assert.rejects(fs.stat(f.lock), { code: 'ENOENT' });
});
