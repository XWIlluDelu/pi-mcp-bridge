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

test('terminal seal observes local preparation and notifies maintenance after all work finishes', async () => {
  class Session {
    sessionManager = {};
    async prompt(work) {
      return await work;
    }
    async executeBash(work) {
      return await work;
    }
  }
  const admission = reloadAdmission(Session),
    session = new Session(),
    manager = session.sessionManager,
    promptGate = deferred(),
    bashGate = deferred(),
    ctx = { isIdle: () => true, hasPendingMessages: () => false };
  let notifications = 0;
  admission.setOnIdle(manager, () => notifications++);
  const prompting = session.prompt(promptGate.promise),
    bashing = session.executeBash(bashGate.promise);
  assert.equal(admission.seal(manager, ctx), false);
  promptGate.resolve('input finished');
  assert.equal(await prompting, 'input finished');
  assert.equal(notifications, 0);
  assert.equal(admission.seal(manager, ctx), false);
  bashGate.resolve('bash finished');
  assert.equal(await bashing, 'bash finished');
  assert.equal(notifications, 1);
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

test('terminal seal outlives old reload scopes and preserves only synchronous custom recording', async () => {
  class Session {
    sessionManager = {};
    isStreaming = false;
    records = [];
    async prompt(text) {
      this.records.push(text);
    }
    async sendCustomMessage(message, options) {
      this.records.push({ message, options });
    }
    async reload() {}
  }
  const admission = reloadAdmission(Session),
    session = new Session(),
    manager = session.sessionManager,
    ctx = { isIdle: () => true, hasPendingMessages: () => false },
    operation = admission.begin(manager, ctx),
    later = deferred();
  let delayed;
  assert.equal(
    admission.seal(manager, ctx),
    false,
    'reload admission still owns its temporary fence',
  );
  await operation.run(async () => {
    await session.reload();
    delayed = later.promise.then(() => session.prompt('stale reload context'));
  });
  assert.equal(admission.seal(manager, ctx), true);
  operation.cancel();
  assert.equal(admission.sealed(manager), true, 'old reload cancellation cannot unseal shutdown');
  later.resolve();
  await assert.rejects(delayed, /RUNTIME_SHUTTING_DOWN/);
  assert.throws(() => admission.begin(manager, ctx), /RUNTIME_SHUTTING_DOWN/);
  for (const options of [undefined, { triggerTurn: false }, { deliverAs: 'followUp' }])
    await session.sendCustomMessage('cleanup', options);
  for (const options of [
    { triggerTurn: true },
    { deliverAs: 'nextTurn' },
    { triggerTurn: false, deliverAs: 'nextTurn' },
  ])
    await assert.rejects(session.sendCustomMessage('new work', options), /RUNTIME_SHUTTING_DOWN/);
  session.isStreaming = true;
  await assert.rejects(
    session.sendCustomMessage('deferred recording', { triggerTurn: false }),
    /RUNTIME_SHUTTING_DOWN/,
  );
  assert.equal(session.records.length, 3);
  assert.ok(session.records.every(({ message }) => message === 'cleanup'));
});

test('maintenance callback failures cannot change native operation failures', async () => {
  const nativeError = new Error('native failure');
  class Session {
    sessionManager = {};
    async executeBash() {
      throw nativeError;
    }
  }
  const admission = reloadAdmission(Session),
    session = new Session();
  admission.setOnIdle(session.sessionManager, () => {
    throw new Error('notification failed');
  });
  await assert.rejects(session.executeBash(), (error) => error === nativeError);
  assert.equal(
    admission.seal(session.sessionManager, { isIdle: () => true, hasPendingMessages: () => false }),
    true,
  );
});

test('idle compact excludes local preparation and retains an atomic gate through native completion', async () => {
  class Session {
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
    async reload() {}
  }
  const admission = reloadAdmission(Session),
    session = new Session(),
    manager = session.sessionManager;
  const ctx = { isIdle: () => true, hasPendingMessages: () => false };
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
