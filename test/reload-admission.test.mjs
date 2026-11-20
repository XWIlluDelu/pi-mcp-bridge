import { AdmissionSession } from './fixtures/admission-session.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { reloadAdmission } from '../src/runtime/reload-admission.mjs';
const deferred = () => Promise.withResolvers();
const idle = { isIdle: () => true, hasPendingMessages: () => false };
function fixture() {
  class Session extends AdmissionSession {
    sessionManager = {};
    async prompt(work) {
      return await work;
    }
    async executeBash(work) {
      return await work;
    }
    async compact(work) {
      return await work;
    }
    async setModel() {
      return 'selected';
    }
    async cycleModel() {
      await this.prompt('input from a model hook');
    }
    async reload(work) {
      await work?.();
    }
  }
  const admission = reloadAdmission(Session),
    session = new Session();
  return { Session, admission, session, manager: session.sessionManager, ctx: idle };
}
test('reload admission tracks public operations and expires privilege with that reload', async () => {
  const { admission, session, manager, ctx } = fixture();
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

test('terminal seal observes local preparation and notifies maintenance after all work finishes', async () => {
  const { Session, admission, session, manager, ctx } = fixture(),
    promptGate = deferred(),
    bashGate = deferred();
  let notifications = 0,
    retiredNotifications = 0;
  admission.setOnIdle(manager, () => retiredNotifications++);
  const prompting = session.prompt(promptGate.promise),
    bashing = session.executeBash(bashGate.promise);
  reloadAdmission(Session).setOnIdle(manager, () => notifications++);
  assert.equal(admission.seal(manager, ctx), false);
  promptGate.resolve('input finished');
  assert.equal(await prompting, 'input finished');
  assert.equal(notifications, 0);
  assert.equal(admission.seal(manager, ctx), false);
  bashGate.resolve('bash finished');
  assert.equal(await bashing, 'bash finished');
  assert.equal(notifications, 1);
  assert.equal(retiredNotifications, 0);
  for (const [nativeIdle, queued, otherBusy] of [
    [false, false, false],
    [true, true, false],
    [true, false, true],
    [undefined, false, false],
    [true, undefined, false],
  ])
    assert.equal(
      admission.seal(
        manager,
        { isIdle: () => nativeIdle, hasPendingMessages: () => queued },
        otherBusy,
      ),
      false,
    );
  assert.equal(admission.seal(manager, ctx), true);
  assert.equal(admission.sealed(manager), true);
  assert.equal(admission.idle(manager), false);
  assert.equal(
    reloadAdmission(Session).seal(manager, ctx),
    true,
    'the same generation stays sealed',
  );
  await assert.rejects(session.prompt('after seal'), /RUNTIME_SHUTTING_DOWN/);
  await assert.rejects(session.executeBash('after seal'), /RUNTIME_SHUTTING_DOWN/);
  assert.equal(notifications, 1);
});

test('idle compact excludes local preparation and retains an atomic gate through native completion', async () => {
  const { admission, session, manager, ctx } = fixture();
  const preparing = deferred(),
    prepared = session.prompt(preparing.promise);
  await assert.rejects(
    admission.compact(manager, ctx, () => assert.fail('Must not interrupt input')),
    /COMPACT_BUSY/,
  );
  preparing.resolve();
  await prepared;
  const finished = deferred(),
    later = deferred();
  let delayed;
  const compacting = admission.compact(manager, ctx, async () => {
    delayed = later.promise.then(() => session.prompt('stale compact scope'));
    return await session.compact(finished.promise);
  });
  assert.equal(admission.idle(manager), false);
  assert.equal(admission.reloading(manager), false);
  assert.equal(admission.seal(manager, ctx), false);
  assert.throws(() => admission.begin(manager, ctx), /RELOAD_BUSY/);
  await assert.rejects(session.prompt('new input'), /COMPACTION_PENDING/);
  await assert.rejects(session.executeBash('new bash'), /COMPACTION_PENDING/);
  assert.equal(await session.setModel(), 'selected');
  await assert.rejects(session.cycleModel(), /COMPACTION_PENDING/);
  await assert.rejects(
    admission.compact(manager, ctx, () => {}),
    /COMPACT_BUSY/,
  );
  finished.resolve('compacted');
  assert.equal(await compacting, 'compacted');
  assert.equal(admission.idle(manager), true);
  assert.equal(admission.completed(manager), false, 'compact must not claim a completed reload');
  const reload = admission.begin(manager, ctx);
  later.resolve();
  await assert.rejects(delayed, /RELOAD_IN_PROGRESS/);
  await reload.run(() => session.reload());
  await assert.rejects(
    admission.compact(manager, ctx, () => {
      throw new Error('failed');
    }),
    /failed/,
  );
  assert.equal(admission.idle(manager), true);
  assert.equal(admission.completed(manager), true, 'compact must not clear reload evidence');
  assert.equal(admission.seal(manager, ctx), true);
  await assert.rejects(
    admission.compact(manager, ctx, () => {}),
    /RUNTIME_SHUTTING_DOWN/,
  );
});
