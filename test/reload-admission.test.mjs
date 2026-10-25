import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAdmission } from '../src/reload-admission.mjs';
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
test('reload admission tracks public operations and expires privilege with that reload', async () => {
  class Session {
    sessionManager = {};
    async prompt(work) {
      return await work;
    }
    async executeBash(work) {
      return await work;
    }
    async reload(work) {
      return await work();
    }
  }
  const admission = reloadAdmission(Session),
    session = new Session(),
    manager = session.sessionManager;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false };
  const work = deferred(),
    bashing = session.executeBash(work.promise);
  assert.throws(() => admission.begin(manager, ctx), /RELOAD_BUSY/);
  work.resolve();
  await bashing;
  const first = admission.begin(manager, ctx),
    later = deferred(),
    called = deferred();
  let delayed;
  await first.run(async () => {
    await session.reload(async () => {});
    // A callback created by a reload hook must not keep a permanent bypass.
    delayed = later.promise.then(async () => {
      try {
        await session.prompt('late');
        called.resolve(false);
      } catch {
        called.resolve(true);
      }
    });
  });
  assert.equal(admission.completed(manager), true);
  const second = admission.begin(manager, ctx);
  await assert.rejects(session.prompt('outside'), /RELOAD_IN_PROGRESS/);
  later.resolve();
  await delayed;
  assert.equal(await called.promise, true);
  second.cancel();
  await session.prompt('allowed');
  const failed = admission.begin(manager, ctx);
  await assert.rejects(
    failed.run(() => Promise.reject(new Error('native failure'))),
    /native failure/,
  );
  assert.equal(admission.completed(manager), false);
});
