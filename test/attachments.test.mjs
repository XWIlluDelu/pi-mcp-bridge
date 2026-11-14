import { nativeOwner } from './fixtures/native-owner.mjs';

import { test } from 'node:test';

import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import net from 'node:net';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Bridge } from '../src/bridge.mjs';
import {
  AttachedRuntime,
  readClaim,
  reserveOwner,
  ownerAlive,
  registryTransaction,
} from '../src/attachments.mjs';
import attachExtension from './fixtures/companion.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture = (t) =>
  nativeOwner(t, {
    prefix: 'attach',
    configure: ({ config }) => {
      config.attachmentExitTimeoutMs = 4000;
    },
  });
async function until(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw last ?? new Error('Fixture deadline');
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
async function tui(t, f, { expectFailure = false } = {}) {
  const agentDir = path.join(f.dir, 'agent');
  await fs.mkdir(agentDir);
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  const commands = path.join(f.dir, 'commands.mjs');
  await fs.writeFile(
    commands,
    `export default function(pi){pi.registerCommand('fixture-fork',{handler:async(_a,ctx)=>{await ctx.fork(ctx.sessionManager.getEntries().find(e=>e.type==='message'&&e.message.role==='user').id,{position:'at'});}});}`,
  );
  const args = [
    process.execPath,
    nativePiCli,
    '--session',
    f.session.file,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-tools',
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '-e',
    path.join(base, 'src/attach-extension.mjs'),
    '-e',
    commands,
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  ];
  const child = spawn('script', ['-qefc', args.map(quote).join(' '), '/dev/null'], {
    cwd: f.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_ATTACH_DIR: f.config.attachmentDir,
      PI_OFFLINE: '1',
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-24000);
  });
  child.stderr.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-24000);
  });
  let record;
  t.after(async () => {
    // Clean up any TUI left alive by a test that did not delete it.
    if (record && (await ownerAlive(record.owner))) process.kill(record.owner.pid, 'SIGTERM');
    child.stdin.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  if (expectFailure) return { child, getLog: () => log };
  try {
    record = await until(async () => {
      const r = await readClaim(f.config.attachmentDir, f.session);
      return r?.phase === 'ready' ? r : null;
    });
  } catch (e) {
    throw new Error('TUI startup failed: ' + log.slice(-3000), { cause: e });
  }
  return { child, record, getLog: () => log };
}

test('overlong attachment path prevents bridge startup and official TUI exits on registration failure', async (t) => {
  const f = await fixture(t);
  await f.bridge.close();
  f.config.attachmentDir = path.join(f.dir, 'x'.repeat(80));
  await assert.rejects(new Bridge(f.config).init(), /ATTACHMENT_SOCKET_PATH_TOO_LONG/);
  const launched = await tui(t, f, { expectFailure: true });
  await until(() => launched.child.exitCode !== null);
  assert.ok(launched.getLog().includes('ATTACHMENT_SOCKET_PATH_TOO_LONG'));
  assert.ok(await fs.stat(f.session.file));
  assert.equal(f.bridge.pool.instances.size, 0);
});

test('delayed shutdown flush cannot call a replaced or invalidated Pi context', async (t) => {
  const f = await fixture(t),
    previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {},
    callbacks = [];
  let shutdowns = 0;
  await attachExtension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const originalEnd = net.Socket.prototype.end;
  t.mock.method(net.Socket.prototype, 'end', function (...args) {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('"shutdown":"requested"') &&
      typeof args[1] === 'function'
    ) {
      callbacks.push(args[1]);
      args.splice(1, 1);
    }
    return originalEnd.apply(this, args);
  });
  const manager = {
    getSessionFile: () => f.session.file,
    getHeader: () => f.session.header,
    getSessionId: () => f.session.header.id,
  };
  const context = () => {
    const state = { valid: true };
    const check = () => {
      if (!state.valid) throw new Error('Pi extension context is no longer active');
    };
    const ctx = {
      mode: 'tui',
      get sessionManager() {
        check();
        return manager;
      },
      shutdown: () => {
        check();
        shutdowns++;
      },
    };
    return { state, ctx };
  };
  let current = context();
  try {
    await handlers.session_start({ reason: 'startup' }, current.ctx);
    let runtime = new AttachedRuntime(
      f.config,
      f.session,
      await readClaim(f.config.attachmentDir, f.session),
    );
    assert.equal((await runtime.request('shutdown')).shutdown, 'requested');
    assert.equal(callbacks.length, 1);
    await handlers.session_shutdown({ reason: 'reload' }, current.ctx);
    current.state.valid = false;
    current = context();
    await handlers.session_start({ reason: 'reload' }, current.ctx);
    assert.doesNotThrow(() => callbacks.shift()());
    assert.equal(shutdowns, 0);
    runtime = new AttachedRuntime(
      f.config,
      f.session,
      await readClaim(f.config.attachmentDir, f.session),
    );
    await runtime.request('shutdown');
    current.state.valid = false;
    assert.doesNotThrow(() => callbacks.shift()());
    assert.equal(shutdowns, 0);
    current.state.valid = true;
    await runtime.request('shutdown');
    callbacks.shift()();
    assert.equal(shutdowns, 1);
  } finally {
    await handlers.session_shutdown({ reason: 'quit' }, current.ctx);
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
});

test('registry failure during shutdown still closes old socket and retains blocking ownership', async (t) => {
  const f = await fixture(t),
    previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  await attachExtension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getHeader: () => f.session.header,
      getSessionId: () => f.session.header.id,
    },
  };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let held;
  try {
    await handlers.session_start({ reason: 'startup' }, ctx);
    const record = await readClaim(f.config.attachmentDir, f.session);
    held = registryTransaction(f.config.attachmentDir, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(
      handlers.session_shutdown({ reason: 'reload' }, ctx),
      /ATTACHMENT_REGISTRY_BUSY/,
    );
    await assert.rejects(fs.stat(record.socket), { code: 'ENOENT' });
    release.resolve();
    await held;
    assert.equal(
      (await readClaim(f.config.attachmentDir, f.session)).generation,
      record.generation,
    );
    assert.equal(await ownerAlive(record.owner), true);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
  } finally {
    release.resolve();
    await held;
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
});

test('official TUI session replacement registers a fresh identity and socket loss does not spawn RPC', async (t) => {
  const f = await fixture(t);
  const launched = await tui(t, f);
  await f.bridge.send({ session_id: f.id, text: 'public fork fixture' });
  await until(async () =>
    (await f.bridge.read({ session_id: f.id })).items.some((x) => x.type === 'assistant'),
  );
  await until(async () => !(await f.bridge.pool.get(f.id).state()).isStreaming);
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: '/fixture-fork' })).status,
    'dispatched',
  );
  const fork = await until(async () => (await f.bridge.sessions()).find((s) => s.id !== f.id));
  const forkClaim = await until(async () => {
    const r = await readClaim(f.config.attachmentDir, fork);
    return r?.phase === 'ready' ? r : null;
  });
  assert.notEqual(forkClaim.generation, launched.record.generation);
  // Ready publication precedes asynchronous old-claim cleanup. Await both
  // lifecycle conditions instead of assuming they are a single transaction.
  await until(async () => (await readClaim(f.config.attachmentDir, f.session)) === null);
  assert.equal(await ownerAlive(forkClaim.owner), true);
  const replacement = fork;
  const claim = forkClaim;
  const read = await f.bridge.read({ session_id: replacement.id });
  assert.match(JSON.stringify(read), /public fork fixture/);
  await fs.unlink(claim.socket);
  const result = await f.bridge.send({
    session_id: replacement.id,
    text: 'do not start a second process',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'LIVE_OWNER_UNREACHABLE');
  assert.equal(await ownerAlive(claim.owner), true);
  assert.equal(f.bridge.pool.get(replacement.id).attached, true);
  const removed = await f.bridge.delete({
    session_id: replacement.id,
  });
  assert.equal(removed.status, 'deleted', JSON.stringify(removed));
  assert.equal(await ownerAlive(claim.owner), false);
  await assert.rejects(fs.stat(replacement.file), { code: 'ENOENT' });
});
