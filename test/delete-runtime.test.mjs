import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Bridge } from '../src/bridge.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import {
  processIdentity,
  claimFile,
  ownerAlive,
  reserveOwner,
  updateOwner,
  readClaim,
  AttachedRuntime,
  releaseOwner,
} from '../src/attachments.mjs';

async function fixture(t, { native = false } = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-delete-');
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    attachmentExitTimeoutMs: 50,
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    defaults: denyAllPermissions(),
    grants: [{ folder: dir, delete: true }],
  };
  const bridge = await new Bridge(
    config,
    native
      ? undefined
      : () => {
          throw new Error('DELETE_MUST_NOT_START_PI');
        },
  ).init();
  const make = async () => bridge.session((await savedSession(bridge)).session_id);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, config, bridge, make, cleanups };
}
async function writer(t, stubborn = false) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    ${stubborn ? "process.on('SIGTERM', () => {});" : ''}
    process.send('ready');
    setInterval(() => {}, 1000);
  `,
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  );
  await once(child, 'message');
  const owner = await processIdentity(child.pid);
  t.after(async () => {
    if (await ownerAlive(owner)) {
      const exit = once(child, 'exit');
      child.kill('SIGKILL');
      await exit;
    }
  });
  return { child, owner };
}

for (const stage of ['native readiness', 'failed startup cleanup'])
  test(
    `delete interrupts ${stage} without waiting for startup to finish`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t, { native: true }),
        target = await f.make(),
        extension = path.join(f.dir, 'startup.mjs');
      const marker = path.join(f.dir, 'entered');
      await fs.writeFile(
        extension,
        `
      import fs from 'node:fs';
      process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(path.join(f.dir, 'cleanup-waiting'))}, 'yes'));
      export default pi => pi.on('session_start', async (_event, ctx) => {
        fs.writeFileSync(${JSON.stringify(marker)}, 'yes');
        ${stage === 'native readiness' ? 'await new Promise(() => {});' : "await ctx.ui.confirm('Startup', 'Continue?');"}
      });
    `,
      );
      f.config.piArgs.push('-e', extension);
      f.config.grants[0].send = true;
      const sent = f.bridge.send({ session_id: target.id, text: 'MUST_NOT_REACH_PI' });
      f.cleanups.push(async () => {
        const rpc =
          f.bridge.pool.starting.get(target.id)?.runtime ?? f.bridge.pool.instances.get(target.id);
        if (rpc?.childIdentity && (await ownerAlive(rpc.childIdentity)))
          process.kill(rpc.childIdentity.pid, 'SIGKILL');
        await sent;
      });
      const waitFor = stage === 'native readiness' ? marker : path.join(f.dir, 'cleanup-waiting');
      while (!(await fs.stat(waitFor).catch(() => null)))
        await new Promise((resolve) => setTimeout(resolve, 10));
      const rpc = f.bridge.pool.starting.get(target.id).runtime,
        owner = structuredClone(rpc.childIdentity);
      assert.equal(await ownerAlive(owner), true);
      const deleted = await f.bridge.delete({ session_id: target.id });
      assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
      assert.equal((await sent).status, 'rejected');
      assert.equal(await ownerAlive(owner), false);
      assert.equal(await readClaim(f.config.attachmentDir, target), null);
      assert.equal(f.bridge.pool.starting.has(target.id), false);
      await assert.rejects(fs.stat(target.file), { code: 'ENOENT' });
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(f.config.stateDir, 'trash', deleted.restore_token + '.restore.json'),
          'utf8',
        ),
      );
      assert.equal(manifest.native_session_id, target.header.id);
      assert.doesNotMatch(await fs.readFile(manifest.trash_path, 'utf8'), /MUST_NOT_REACH_PI/);
    },
  );

test('delete ends an unsupported live claim without treating its socket metadata as file authority', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    live = await writer(t);
  const record = await reserveOwner(f.config.attachmentDir, target, 'extension', live.owner);
  const unrelated = path.join(f.dir, 'unrelated-data');
  await fs.writeFile(unrelated, 'KEEP');
  await fs.writeFile(
    claimFile(f.config.attachmentDir, target),
    JSON.stringify({
      ...record,
      kind: 'unsupported-endpoint',
      generation: null,
      socket: unrelated,
    }),
  );
  const exit = once(live.child, 'exit');
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  await exit;
  assert.equal(await ownerAlive(live.owner), false);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'KEEP');
  assert.equal(await readClaim(f.config.attachmentDir, target), null);
});

for (const kind of ['extension', 'rpc', 'host'])
  test(
    'delete-only authorization terminates unsupported/unreachable ' +
      kind +
      ' and escalates without touching another writer',
    async (t) => {
      const f = await fixture(t),
        target = await f.make(),
        neighbor = await f.make();
      const a = await writer(t, true),
        b = await writer(t);
      if (kind === 'host') {
        const host = await reserveHostSession({
          attachmentDir: f.config.attachmentDir,
          session: target,
          owner: a.owner,
        });
        f.cleanups.push(() => host.close());
        await host.ready({
          state: async () => ({ sessionFile: target.file, sessionId: target.header.id }),
          snapshot: async () => ({ entries: [], leafId: null }),
          submit: async () => {
            throw new Error('DELETE_MUST_NOT_SEND');
          },
        });
      } else await reserveOwner(f.config.attachmentDir, target, kind, a.owner);
      await reserveOwner(f.config.attachmentDir, neighbor, 'rpc', b.owner);
      // Either unreachable, or an explicit HOST_RELEASE_UNSUPPORTED response.
      // No read/list/stop permissions are granted.
      const exited = once(a.child, 'exit');
      const result = await f.bridge.delete({ session_id: target.id });
      assert.equal(result.status, 'deleted', JSON.stringify(result));
      assert.equal((await exited)[1], 'SIGKILL');
      assert.equal(await ownerAlive(a.owner), false);
      assert.equal(await ownerAlive(b.owner), true);
      assert.ok(await fs.stat(neighbor.file));
      assert.equal(await readClaim(f.config.attachmentDir, target), null);
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(f.config.stateDir, 'trash', result.restore_token + '.restore.json'),
          'utf8',
        ),
      );
      assert.equal(manifest.native_session_id, target.header.id);
      assert.ok(await fs.stat(manifest.trash_path));
      assert.equal(manifest.original_path, target.file);
    },
  );

for (const callback of ['cancel', 'release'])
  for (const shared of [false, true])
    test(`host ${callback} exception permits dedicated termination but preserves shared owners (shared=${shared})`, async (t) => {
      const f = await fixture(t),
        target = await f.make(),
        neighbor = await f.make(),
        a = await writer(t);
      const b = shared ? a : await writer(t);
      const host = await reserveHostSession({
        attachmentDir: f.config.attachmentDir,
        session: target,
        owner: a.owner,
      });
      f.cleanups.push(() => host.close());
      await reserveOwner(f.config.attachmentDir, neighbor, 'rpc', b.owner);
      let failed = false,
        released = false;
      await host.ready({
        state: async () => ({ sessionFile: target.file, sessionId: target.header.id }),
        snapshot: async () => ({ entries: [], leafId: null }),
        submit: async () => {
          throw new Error('DELETE_MUST_NOT_SEND');
        },
        cancel: async () => {
          if (callback === 'cancel') {
            failed = true;
            throw new Error('ordinary cancellation failure');
          }
        },
        release: async () => {
          released = true;
          failed = true;
          throw new Error('ordinary release failure');
        },
      });
      const result = await f.bridge.delete({ session_id: target.id });
      assert.equal(failed, true, 'exercise the actual callback, not a transport timeout');
      assert.equal(released, callback === 'release');
      assert.equal(await ownerAlive(b.owner), true);
      assert.ok(await fs.stat(neighbor.file));
      if (shared) {
        assert.equal(result.reason, 'DELETE_SHARED_OWNER', JSON.stringify(result));
        assert.ok(await fs.stat(target.file));
      } else {
        assert.equal(result.status, 'deleted', JSON.stringify(result));
        assert.equal(await ownerAlive(a.owner), false);
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(f.config.stateDir, 'trash', result.restore_token + '.restore.json'),
            'utf8',
          ),
        );
        assert.ok(await fs.stat(manifest.trash_path));
      }
    });

test('delete refuses stale binding and shared-process termination', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    neighbor = await f.make();
  const a = await writer(t);
  const claim = await reserveOwner(f.config.attachmentDir, target, 'extension', a.owner);
  const runtime = new AttachedRuntime(f.config, target, claim);
  const shared = await reserveOwner(f.config.attachmentDir, neighbor, 'host', a.owner);
  await assert.rejects(runtime.stopForDelete(), /DELETE_SHARED_OWNER/);
  assert.equal(await ownerAlive(a.owner), true);
  await releaseOwner(f.config.attachmentDir, neighbor, shared);
  await updateOwner(f.config.attachmentDir, target, { ...claim }, { generation: 'replacement' });
  await assert.rejects(runtime.stopForDelete(), /RUNTIME_SESSION_CHANGED/);
  assert.equal(await ownerAlive(a.owner), true);
  assert.ok(await fs.stat(target.file));
});

test('lost release ACK uses confirmed target closure without terminating the shared host', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    neighbor = await f.make(),
    a = await writer(t);
  // This case discards a completed ACK; it is not a short-timeout test.
  delete f.config.attachmentExitTimeoutMs;
  const host = await reserveHostSession({
    attachmentDir: f.config.attachmentDir,
    session: target,
    owner: a.owner,
  });
  f.cleanups.push(() => host.close());
  await reserveOwner(f.config.attachmentDir, neighbor, 'host', a.owner);
  await host.ready({
    state: async () => ({ sessionFile: target.file, sessionId: target.header.id }),
    snapshot: async () => ({ entries: [], leafId: null }),
    submit: async () => {
      throw new Error('DELETE_MUST_NOT_SEND');
    },
    release: async () => ({ released: true }),
  });
  const request = AttachedRuntime.prototype.request;
  let released = false;
  t.mock.method(AttachedRuntime.prototype, 'request', async function (op, ...args) {
    const result = await request.call(this, op, ...args);
    if (op !== 'release') return result;
    assert.equal(await readClaim(f.config.attachmentDir, target), null);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, target, 'host', a.owner),
      /LIVE_OWNER_UNREACHABLE/,
    );
    released = true;
    throw new Error('lost release acknowledgement');
  });
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(released, true, 'complete release over real IPC before discarding the ACK');
  assert.equal(await ownerAlive(a.owner), true);
  assert.ok(await fs.stat(neighbor.file));
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  const manifest = JSON.parse(
    await fs.readFile(
      path.join(f.config.stateDir, 'trash', result.restore_token + '.restore.json'),
      'utf8',
    ),
  );
  assert.ok(await fs.stat(manifest.trash_path));
  await assert.rejects(fs.stat(target.file), { code: 'ENOENT' });
});

test('delete includes a successor admitted before it acquires session-wide authority', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    before = await writer(t),
    successor = await writer(t);
  const first = await reserveOwner(f.config.attachmentDir, target, 'rpc', before.owner);
  const stop = f.bridge.pool.stopForDelete.bind(f.bridge.pool);
  let replacement;
  t.mock.method(f.bridge.pool, 'stopForDelete', async (session) => {
    // Normal ownership transfer finishes while deletion is still preparing.
    const exited = once(before.child, 'exit');
    before.child.kill('SIGTERM');
    await exited;
    await releaseOwner(f.config.attachmentDir, target, first);
    replacement = await reserveOwner(f.config.attachmentDir, target, 'rpc', successor.owner);
    return stop(session);
  });
  const result = await f.bridge.delete({ session_id: target.id });
  assert.notEqual(first.generation, replacement.generation);
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  assert.equal(await ownerAlive(successor.owner), false);
  await assert.rejects(fs.stat(target.file), { code: 'ENOENT' });
});

test('a failing host release cannot authorize termination after its binding changes', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    a = await writer(t);
  const host = await reserveHostSession({
    attachmentDir: f.config.attachmentDir,
    session: target,
    owner: a.owner,
  });
  f.cleanups.push(() => host.close());
  await host.ready({
    state: async () => ({ sessionFile: target.file, sessionId: target.header.id }),
    snapshot: async () => ({ entries: [], leafId: null }),
    submit: async () => {
      throw new Error('DELETE_MUST_NOT_SEND');
    },
    release: async () => {
      await updateOwner(
        f.config.attachmentDir,
        target,
        { ...host.record },
        { generation: 'replacement' },
      );
      throw new Error('ordinary release failure after replacement');
    },
  });
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(result.reason, 'RUNTIME_SESSION_CHANGED', JSON.stringify(result));
  assert.equal(await ownerAlive(a.owner), true);
  assert.equal((await readClaim(f.config.attachmentDir, target)).generation, 'replacement');
  assert.ok(await fs.stat(target.file));
});

test('denied delete does not signal the owner or prepare trash', async (t) => {
  const f = await fixture(t),
    target = await f.make(),
    a = await writer(t);
  await reserveOwner(f.config.attachmentDir, target, 'extension', a.owner);
  f.config.grants = [];
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(result.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(await ownerAlive(a.owner), true);
  await assert.rejects(fs.stat(path.join(f.config.stateDir, 'trash')), { code: 'ENOENT' });
});
