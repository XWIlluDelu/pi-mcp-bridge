import { nativeOwner, nativeTui, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import { test } from 'node:test';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';

import { META, MODERN_VERSION } from '../src/protocol.mjs';
import { readClaim, ownerAlive } from '../src/attachments.mjs';
const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const exists = (file) =>
  fs.stat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
async function fixture(t) {
  const f = await nativeOwner(t, {
    prefix: 'stdio-life',
    async configure(context) {
      context.config.piArgs = ['--offline'];
      await gatedExtension(
        context,
        `
        pi.registerCommand('lifecycle-fixture', { handler: async () => {
          await mark('dispatch');
          await new Promise(r => setTimeout(r, 300));
        } });
      `,
      );
    },
  });
  await f.bridge.close();
  return { ...f, marker: path.join(f.dir, 'dispatch') };
}
function launch(t, f, nodeArgs = []) {
  const child = spawn(
    process.execPath,
    [...nodeArgs, path.join(base, 'src/server.mjs'), f.configFile],
    {
      cwd: base,
      env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '',
    next = 0;
  const pending = new Map();
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    const resolve = pending.get(value.id);
    if (resolve) {
      pending.delete(value.id);
      resolve(value);
    }
  });
  const done = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    lines.close();
  });
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      write({ jsonrpc: '2.0', id, method, params });
    });
  const bounded = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP fixture timeout')), 10000);
        timer.unref();
      }),
    ]);
  const call = async (name, args) => {
    const result = (await bounded(request('tools/call', { name, arguments: args }))).result;
    assert.ok(result && !result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  return {
    child,
    call,
    request,
    done,
    stderr: () => stderr,
    initialize: async (protocolVersion = '2024-11-05') => {
      const r = await bounded(
        request('initialize', {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'lifecycle-fixture', version: '1' },
        }),
      );
      assert.ok(r.result);
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    exit: async () => {
      const result = await bounded(done);
      assert.equal(result.signal, null, stderr);
      return result.code;
    },
  };
}
async function stopped(f, owner) {
  if (owner) assert.equal(await ownerAlive(owner), false);
  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
}
async function ownClaim(f) {
  return until(async () => {
    const r = await readClaim(f.config.attachmentDir, f.session);
    return r?.phase === 'ready' ? r : null;
  });
}

for (const stage of ['before-acquire', 'after-acquire', 'owner-listen-failure'])
  test(`stop during initialization waits for ${stage} and releases only its acquired lock`, async (t) => {
    const f = await fixture(t),
      preload = path.join(f.dir, 'pause-init.mjs'),
      reached = path.join(f.dir, 'init-reached'),
      release = path.join(f.dir, 'init-release');
    await fs.writeFile(
      preload,
      `import {holdInit} from ${JSON.stringify(new URL('./fixtures/init-gate.mjs', import.meta.url).href)};holdInit(${JSON.stringify({ config: f.config, stage, reached, release })});`,
    );
    const server = launch(t, f, ['--import', preload]);
    await until(() => exists(reached));
    server.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 80));
    server.child.kill('SIGINT');
    assert.equal(server.child.exitCode, null);
    assert.equal(
      server.child.signalCode,
      null,
      'Signal handlers must be active before init acquires resources',
    );
    await fs.writeFile(release, 'continue');
    assert.equal(await server.exit(), stage === 'owner-listen-failure' ? 1 : 0);
    await stopped(f);
    const restarted = launch(t, f);
    await restarted.initialize();
    restarted.child.stdin.end();
    assert.equal(await restarted.exit(), 0);
    await stopped(f);
  });

test('modern stdio discovers without initialize and EOF drains native input before restart', async (t) => {
  const f = await fixture(t),
    server = launch(t, f);
  const _meta = { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} };
  assert.equal((await server.request('server/discover', { _meta })).result.resultType, 'complete');
  const pending = server.request('tools/call', {
    name: 'send',
    arguments: { session_id: f.id, text: '/lifecycle-fixture' },
    _meta,
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  server.child.stdin.end();
  const response = await pending;
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.structuredContent.status, 'handled');
  assert.equal(await server.exit(), 0);
  await stopped(f, claim.owner);
  const second = launch(t, f);
  const listed = await second.request('tools/call', {
    name: 'list',
    arguments: { session_id: f.id },
    _meta,
  });
  assert.equal(listed.result.structuredContent.sessions[0].session_id, f.id);
  second.child.stdin.end();
  assert.equal(await second.exit(), 0);
});

test('broken stdout drains a pending receipt and cleans up the owned official RPC process', async (t) => {
  const f = await fixture(t),
    server = launch(t, f);
  await server.initialize();
  server.request('tools/call', {
    name: 'send',
    arguments: { session_id: f.id, text: '/lifecycle-fixture' },
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  server.child.stdout.destroy();
  server.request('tools/list', {});
  assert.equal(await server.exit(), 1);
  await stopped(f, claim.owner);
  assert.ok(!server.stderr().includes('Unhandled'));
  const bridge = await new Bridge(f.config).init();
  try {
    assert.equal((await bridge.list({ session_id: f.id })).sessions.length, 1);
    assert.equal(bridge.pool.instances.size, 0);
  } finally {
    await bridge.close();
  }
});

test('stdio EOF disconnects a native TUI without stopping its writer', async (t) => {
  const f = await fixture(t);
  const tui = await nativeTui(f, f.session);
  const claim = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(claim.kind, 'tui');
  const server = launch(t, f);
  await server.initialize();
  await server.call('read', { session_id: f.id });
  server.child.stdin.end();
  assert.equal(await server.exit(), 0);
  assert.equal(await ownerAlive(tui.owner), true);
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, claim.generation);
});
