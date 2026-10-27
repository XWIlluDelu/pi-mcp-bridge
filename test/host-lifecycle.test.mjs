import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { atomicJson } from '../src/storage.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import attachExtension from './fixtures/companion.mjs';
import {
  reserveOwner,
  releaseOwner,
  readClaim,
  ownerAlive,
  updateOwner,
  AttachedRuntime,
  registryTransaction,
  claimFile,
} from '../src/attachments.mjs';
async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-host-life-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
  };
  let spawns = 0;
  const bridge = await new Bridge(config, async () => {
    spawns++;
    throw Error('UNEXPECTED_SPAWN');
  }).init();
  const created = await savedSession(bridge),
    session = await bridge.session(created.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, config, bridge, session, spawns: () => spawns };
}
const identity = (session) => ({ sessionFile: session.file, sessionId: session.header.id });
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('FIXTURE_TIMEOUT');
}

test('profile companion leaves the same-process host controller and its shutdown lifecycle in charge', async (t) => {
  const f = await fixture(t),
    host = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    }),
    id = identity(f.session);
  const prior = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  await attachExtension({
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });
  const ctx = {
    mode: 'rpc',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getSessionId: () => f.session.header.id,
      getHeader: () => f.session.header,
    },
    isIdle: () => true,
    hasPendingMessages: () => false,
    shutdown: () => assert.fail('companion must not shut down the host'),
  };
  try {
    const initial = await readClaim(f.config.attachmentDir, f.session);
    await handlers.session_start({}, ctx);
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), initial);
    await host.ready({
      state: async () => id,
      snapshot: async () => ({ ...id, entries: [], leafId: null }),
      submit: async () => ({ status: 'unknown' }),
    });
    const ready = await readClaim(f.config.attachmentDir, f.session);
    await handlers.session_start({}, ctx);
    await handlers.session_shutdown({});
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), ready);
    assert.equal((await f.bridge.read({ session_id: f.session.id })).items.length, 0);
    assert.equal(f.spawns(), 0);
  } finally {
    await handlers.session_shutdown({});
    await host.close();
    if (prior === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = prior;
  }
});
test('host close cleans up its listener on registry failure without releasing the live writer', async (t) => {
  const f = await fixture(t),
    listen = net.Server.prototype.listen;
  let listener, connection;
  t.mock.method(net.Server.prototype, 'listen', function (address, ...args) {
    if (typeof address === 'string' && address.startsWith('/')) listener = this;
    return listen.call(this, address, ...args);
  });
  const host = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    }),
    id = identity(f.session);
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let held;
  try {
    await host.ready({
      state: async () => id,
      snapshot: async () => ({ ...id, entries: [], leafId: null }),
      submit: async () => ({ status: 'unknown' }),
    });
    await f.bridge.read({ session_id: f.session.id });
    const claim = await readClaim(f.config.attachmentDir, f.session);
    connection = net.createConnection(claim.socket);
    connection.on('error', () => {});
    await new Promise((resolve, reject) => {
      connection.once('connect', resolve);
      connection.once('error', reject);
    });
    const disconnected = new Promise((resolve) => connection.once('close', resolve));
    held = registryTransaction(f.config.attachmentDir, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(host.close(), /ATTACHMENT_REGISTRY_BUSY/);
    assert.equal(
      listener.listening,
      false,
      'A failed claim update must not leave the controller listening',
    );
    await disconnected;
    await assert.rejects(fs.stat(claim.socket), { code: 'ENOENT' });
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), claim);
    assert.equal(await ownerAlive(claim.owner), true);
    const sent = await f.bridge.send({
      session_id: f.session.id,

      text: 'must not cold-start',
    });
    assert.equal(sent.status, 'rejected');
    assert.equal(sent.reason, 'LIVE_OWNER_UNREACHABLE');
    assert.equal(f.spawns(), 0);
  } finally {
    release.resolve();
    await held;
    // Keep a failing lifecycle regression from leaving a listener in the test runner.
    connection?.destroy();
    if (listener) await new Promise((resolve) => listener.close(resolve));
  }
});

test('deletion blocks reacquisition after host release and continues through the trash move', async (t) => {
  const f = await fixture(t),
    host = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    });
  const id = identity(f.session);
  await host.ready({
    state: async () => id,
    snapshot: async () => ({ ...id, entries: [], leafId: null }),
    submit: async () => ({ status: 'unknown' }),
    release: async () => ({ released: true }),
  });
  let blocked = false;
  try {
    const stop = f.bridge.pool.stop.bind(f.bridge.pool);
    t.mock.method(f.bridge.pool, 'stop', async (sessionId) => {
      await stop(sessionId);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      blocked = true;
    });
    const result = await f.bridge.delete({ session_id: f.session.id });
    assert.equal(blocked, true);
    assert.equal(result.status, 'deleted', JSON.stringify(result));
    await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    assert.equal((await fs.readdir(path.join(f.config.stateDir, 'trash'))).length, 1);
    assert.equal(f.spawns(), 0);
  } finally {
    await host.close();
  }
});

for (const failedStage of ['cancel', 'release'])
  test(`explicit close retry recovers a shared host after ${failedStage} failure without reopening admission`, async (t) => {
    const f = await fixture(t),
      sibling = await f.bridge.session((await savedSession(f.bridge)).session_id),
      host = await reserveHostSession({
        buildSessionProjection: hostProjection,
        attachmentDir: f.config.attachmentDir,
        session: f.session,
      }),
      neighbor = await reserveHostSession({
        buildSessionProjection: hostProjection,
        attachmentDir: f.config.attachmentDir,
        session: sibling,
      }),
      entered = Promise.withResolvers(),
      finish = Promise.withResolvers(),
      failure = new Error('temporary host failure');
    let recovered = false,
      cancels = 0,
      releases = 0;
    const callbacks = (session) => ({
      state: async () => identity(session),
      snapshot: async () => ({ ...identity(session), entries: [], leafId: null }),
      submit: async () => ({ status: 'unknown' }),
    });
    const maybeFail = async (stage) => {
      if (stage !== failedStage || recovered) return;
      entered.resolve();
      await finish.promise;
      throw failure;
    };
    await neighbor.ready(callbacks(sibling));
    await host.ready({
      ...callbacks(f.session),
      cancel: async () => {
        cancels++;
        await maybeFail('cancel');
      },
      release: async () => {
        releases++;
        await maybeFail('release');
        return { released: true };
      },
    });
    try {
      const first = host.release().catch((error) => error);
      assert.equal(
        await Promise.race([entered.promise.then(() => true), first.then(() => false)]),
        true,
      );
      const concurrent = host.release().catch((error) => error);
      finish.resolve();
      assert.equal(await first, failure);
      assert.equal(await concurrent, failure);
      assert.equal(cancels, 1);
      assert.equal(releases, Number(failedStage === 'release'));
      const claim = await readClaim(f.config.attachmentDir, f.session);
      assert.equal(claim.phase, 'transitioning');
      assert.equal(await ownerAlive(claim.owner), true);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      assert.equal(
        (await f.bridge.send({ session_id: f.session.id, text: 'must remain fenced' })).reason,
        'LIVE_OWNER_UNREACHABLE',
      );
      recovered = true;
      const result = await f.bridge.delete({ session_id: f.session.id });
      assert.equal(result.status, 'deleted', JSON.stringify(result));
      assert.equal(cancels, 2);
      assert.equal(releases, failedStage === 'release' ? 2 : 1);
      assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
      assert.equal(
        (await readClaim(f.config.attachmentDir, sibling)).generation,
        neighbor.record.generation,
      );
      assert.equal(await ownerAlive(neighbor.record.owner), true);
      assert.ok(await fs.stat(sibling.file));
      assert.equal(f.spawns(), 0);
    } finally {
      finish.resolve();
      await Promise.allSettled([host.close(), neighbor.close()]);
    }
  });

test('confirmed host deletion removes the local-release pause and late host close cannot resurrect it', async (t) => {
  const f = await fixture(t);
  await f.bridge.releaseForLocal({ session_id: f.session.id });
  const host = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    }),
    id = identity(f.session);
  try {
    await host.ready({
      state: async () => id,
      snapshot: async () => ({ ...id, entries: [], leafId: null }),
      submit: async () => ({ status: 'unknown' }),
      release: async () => ({ released: true }),
    });
    assert.equal(host.record.noColdReacquire, true);
    const result = await f.bridge.delete({
      session_id: f.session.id,
    });
    assert.equal(result.status, 'deleted', JSON.stringify(result));
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    await host.close();
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
    assert.equal(f.spawns(), 0);
  } finally {
    await host.close();
  }
});

test('host close after release preserves its tombstone and rejects live republishing', async (t) => {
  const f = await fixture(t);
  await f.bridge.releaseForLocal({ session_id: f.session.id });
  const host = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    }),
    id = identity(f.session);
  try {
    await host.ready({
      state: async () => id,
      snapshot: async () => ({ ...id, entries: [], leafId: null }),
      submit: async () => ({ status: 'unknown' }),
      release: async () => ({ released: true }),
    });
    await host.release();
    const terminal = await readClaim(f.config.attachmentDir, f.session);
    assert.equal(terminal.generation, host.record.generation);
    assert.equal(terminal.owner, null);
    await host.close();
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), terminal);
    await assert.rejects(
      updateOwner(f.config.attachmentDir, f.session, host.record, { phase: 'ready' }),
      /RUNTIME_SESSION_CHANGED/,
    );
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), terminal);
    assert.equal(await ownerAlive(terminal.owner), false);
  } finally {
    await host.close();
  }
});

for (const replacement of [
  'different-terminal-generation',
  'live-same-generation',
  'live-different-generation',
])
  test('host release receipt rejects ' + replacement, async (t) => {
    const f = await fixture(t);
    await f.bridge.releaseForLocal({ session_id: f.session.id });
    const record = await reserveOwner(f.config.attachmentDir, f.session, 'host');
    await updateOwner(f.config.attachmentDir, f.session, record, { phase: 'ready' });
    const next = {
      ...record,
      generation: replacement === 'live-same-generation' ? record.generation : randomUUID(),
      ...(replacement === 'different-terminal-generation'
        ? { phase: 'released', owner: null }
        : { phase: 'ready' }),
    };
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      socket.once('data', () => {
        void (async () => {
          await registryTransaction(f.config.attachmentDir, () =>
            atomicJson(claimFile(f.config.attachmentDir, f.session), next),
          );
          socket.end(
            JSON.stringify({ generation: record.generation, data: { released: true } }) + '\n',
          );
        })().catch((error) => socket.destroy(error));
      });
    });
    await new Promise((resolve) => server.listen(record.socket, resolve));
    try {
      const runtime = new AttachedRuntime(f.config, f.session, record);
      await assert.rejects(runtime.stopForDelete(), /RUNTIME_SESSION_CHANGED/);
      assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), next);
      assert.ok(await fs.stat(f.session.file));
      assert.equal(f.spawns(), 0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

test('controller death preserves the surviving writer claim and prevents bridge fallback', async (t) => {
  const f = await fixture(t),
    marker = path.join(f.dir, 'ready.json'),
    file = path.join(f.dir, 'controller.json');
  await fs.writeFile(
    file,
    JSON.stringify({ attachmentDir: f.config.attachmentDir, session: f.session, marker }),
  );
  const controller = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/host-controller.mjs', import.meta.url)), file],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => controller.once('exit', resolve));
  let owner;
  try {
    ({ owner } = await until(async () => {
      try {
        return JSON.parse(await fs.readFile(marker, 'utf8'));
      } catch {
        return null;
      }
    }));
    assert.equal((await f.bridge.read({ session_id: f.session.id })).items.length, 0);
    controller.kill('SIGKILL');
    await exited;
    assert.equal(await ownerAlive(owner), true);
    const claim = await readClaim(f.config.attachmentDir, f.session);
    assert.deepEqual(claim.owner, owner);
    await assert.rejects(f.bridge.read({ session_id: f.session.id }), /LIVE_OWNER_UNREACHABLE/);
    const result = await f.bridge.send({
      session_id: f.session.id,

      text: 'public fixture',
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'LIVE_OWNER_UNREACHABLE');
    assert.equal(f.spawns(), 0);
  } finally {
    if (controller.exitCode === null && controller.signalCode === null) {
      controller.kill('SIGKILL');
      await exited;
    }
    if (!owner) {
      try {
        owner = (await readClaim(f.config.attachmentDir, f.session))?.owner;
      } catch {}
    }
    if (owner && (await ownerAlive(owner))) {
      process.kill(owner.pid, 'SIGTERM');
      await until(async () => !(await ownerAlive(owner)));
    }
  }
});
