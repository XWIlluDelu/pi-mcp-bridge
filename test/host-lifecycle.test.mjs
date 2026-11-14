import { nativeOwner } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { reserveHostSession } from '../src/host-adapter.mjs';
import { companionHooks } from './fixtures/companion.mjs';
import { reserveOwner, readClaim, ownerAlive } from '../src/attachments.mjs';
const fixture = (t) => nativeOwner(t, { factory: () => assert.fail('Unexpected second writer') });
const identity = (session) => ({ sessionFile: session.file, sessionId: session.header.id });
const reserve = (f, session = f.session) =>
  reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: f.config.attachmentDir,
    session,
  });
const callbacks = (session) => ({
  state: () => identity(session),
  snapshot: () => ({ ...identity(session), entries: [], leafId: null }),
  submit: () => ({ status: 'unknown' }),
});
test('profile companion leaves the same-process host controller and its shutdown lifecycle in charge', async (t) => {
  const f = await fixture(t),
    host = await reserve(f),
    handlers = await companionHooks(f);
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
    await host.ready(callbacks(f.session));
    const ready = await readClaim(f.config.attachmentDir, f.session);
    await handlers.session_start({}, ctx);
    await handlers.session_shutdown({});
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), ready);
    assert.equal((await f.bridge.read({ session_id: f.session.id })).items.length, 0);
  } finally {
    await host.close();
  }
});

for (const failedStage of ['cancel', 'release'])
  test(`explicit close retry recovers a shared host after ${failedStage} failure without reopening admission`, async (t) => {
    const f = await fixture(t),
      sibling = await f.create(),
      host = await reserve(f),
      neighbor = await reserve(f, sibling),
      entered = Promise.withResolvers(),
      finish = Promise.withResolvers(),
      failure = new Error('temporary host failure');
    let recovered = false,
      cancels = 0,
      releases = 0;
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
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'transitioning');
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
    } finally {
      finish.resolve();
      await Promise.allSettled([host.close(), neighbor.close()]);
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
