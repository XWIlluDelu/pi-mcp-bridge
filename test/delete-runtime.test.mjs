import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { idleProcess, nativeOwner } from './fixtures/native-owner.mjs';
import { restoreManifest } from './fixtures/saved-session.mjs';
import { until } from './fixtures/until.mjs';
import {
  claimFile,
  ownerAlive,
  reserveOwner,
  updateOwner,
  readClaim,
  AttachedRuntime,
} from '../src/runtime/attachments.mjs';

const fixture = (t, native = false) =>
  nativeOwner(t, {
    prefix: 'delete',
    configure({ cwd, config }) {
      config.attachmentExitTimeoutMs = 50;
      config.grants = [{ folder: cwd, delete: true }];
    },
    factory: native ? undefined : () => assert.fail('Delete must not start Pi'),
  });
for (const stage of ['native readiness', 'failed startup cleanup'])
  test(
    `delete interrupts ${stage} without waiting for startup to finish`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(t, true),
        target = f.session,
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
      f.cleanup.push(async () => {
        const rpc =
          f.bridge.pool.starting.get(target.id)?.runtime ?? f.bridge.pool.instances.get(target.id);
        if (rpc?.childIdentity && (await ownerAlive(rpc.childIdentity)))
          process.kill(rpc.childIdentity.pid, 'SIGKILL');
        await sent;
      });
      const waitFor = stage === 'native readiness' ? marker : path.join(f.dir, 'cleanup-waiting');
      await until(() => fs.stat(waitFor).catch(() => null));
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
      const manifest = await restoreManifest(f.config, deleted);
      assert.equal(manifest.native_session_id, target.header.id);
      assert.doesNotMatch(await fs.readFile(manifest.trash_path, 'utf8'), /MUST_NOT_REACH_PI/);
    },
  );

async function hostWriter(f, owner) {
  const { session } = f;
  const host = await f.reserveHost(session, owner);
  const ready = (callbacks) =>
    host.ready({
      state: async () => ({ sessionFile: session.file, sessionId: session.header.id }),
      snapshot: async () => ({ entries: [], leafId: null }),
      submit: () => assert.fail('Delete must not submit'),
      ...callbacks,
    });
  return { host, ready };
}

test('delete ends an unsupported live claim without treating its socket metadata as file authority', async (t) => {
  const f = await fixture(t),
    target = f.session,
    live = await idleProcess(t);
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
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(result.status, 'deleted', JSON.stringify(result));
  await live.exited;
  assert.equal(await ownerAlive(live.owner), false);
  assert.equal(await fs.readFile(unrelated, 'utf8'), 'KEEP');
  assert.equal(await readClaim(f.config.attachmentDir, target), null);
});

for (const callback of ['cancel', 'release'])
  for (const shared of [false, true])
    test(`host ${callback} exception permits dedicated termination but preserves shared owners (shared=${shared})`, async (t) => {
      const f = await fixture(t),
        target = f.session,
        neighbor = await f.create(),
        a = await idleProcess(t);
      const b = shared ? a : await idleProcess(t);
      const { ready } = await hostWriter(f, a.owner);
      await reserveOwner(f.config.attachmentDir, neighbor, 'rpc', b.owner);
      let failed = false,
        released = false;
      await ready({
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
        const manifest = await restoreManifest(f.config, result);
        assert.ok(await fs.stat(manifest.trash_path));
      }
    });

test('lost release ACK uses confirmed target closure without terminating the shared host', async (t) => {
  const f = await fixture(t),
    target = f.session,
    neighbor = await f.create(),
    a = await idleProcess(t);
  // This case discards a completed ACK; it is not a short-timeout test.
  delete f.config.attachmentExitTimeoutMs;
  const { ready } = await hostWriter(f, a.owner);
  await reserveOwner(f.config.attachmentDir, neighbor, 'host', a.owner);
  await ready({ release: async () => ({ released: true }) });
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
  const manifest = await restoreManifest(f.config, result);
  assert.ok(await fs.stat(manifest.trash_path));
  await assert.rejects(fs.stat(target.file), { code: 'ENOENT' });
});

test('a failing host release cannot authorize termination after its binding changes', async (t) => {
  const f = await fixture(t),
    target = f.session,
    a = await idleProcess(t);
  // Exercise the replacement callback, not the fixture's short process-exit deadline.
  delete f.config.attachmentExitTimeoutMs;
  const { host, ready } = await hostWriter(f, a.owner);
  await ready({
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

test('denied delete or replaced target leaves the live owner and history alone', async (t) => {
  const f = await fixture(t),
    target = f.session,
    a = await idleProcess(t);
  await reserveOwner(f.config.attachmentDir, target, 'extension', a.owner);
  f.config.grants = [];
  const result = await f.bridge.delete({ session_id: target.id });
  assert.equal(result.reason, 'NOT_FOUND_OR_DENIED');

  // Both projects allow deletion. The request must still target the identity
  // admitted before it waited for the deletion lane.
  f.config.defaults.delete = true;
  const locked = f.bridge.locked.bind(f.bridge);
  const replacement = { ...target.header, cwd: path.join(f.dir, 'replacement') };
  t.mock.method(f.bridge, 'locked', async (key, run, lane) => {
    if (key === target.id && lane === 'delete')
      await fs.writeFile(target.file, JSON.stringify(replacement) + '\n');
    return locked(key, run, lane);
  });
  assert.equal(
    (await f.bridge.delete({ session_id: target.id })).reason,
    'RUNTIME_SESSION_CHANGED',
  );
  assert.equal(await ownerAlive(a.owner), true);
  assert.equal((await f.bridge.session(target.id)).header.cwd, replacement.cwd);
  await assert.rejects(fs.stat(path.join(f.config.stateDir, 'trash')), { code: 'ENOENT' });
});
