import {
  idleProcess,
  nativeOwner,
  nativeTui,
  fauxArgs,
  gatedExtension,
} from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';

import { restoreManifest, savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';

import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ownerRequest } from '../src/owner-runtime.mjs';
import {
  readClaim,
  processIdentity,
  ownerAlive,
  reserveOwner,
  claimFile,
  AttachedRuntime,
  updateOwner,
  assertNoOtherLiveOwner,
} from '../src/runtime/attachments.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import joinExtension from '../src/runtime/join-extension.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    (error) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    },
  );
async function fixture(t, source = '') {
  const f = await nativeOwner(t, {
    prefix: 'idle',
    async configure(context) {
      context.config.piArgs.push(...fauxArgs, '--thinking', 'off');
      await gatedExtension(context, source);
    },
  });
  return Object.assign(f, {
    request: {
      op: 'handoff',
      session_id: f.id,
      requester: await processIdentity(),
      handoff_id: randomUUID(),
    },
  });
}
const transfer = (f, options) => ownerRequest(f.config, f.request, options);
const cancel = (f) => ownerRequest(f.config, { ...f.request, op: 'handoff_cancel' });

function join(f, switchSession, notify = () => {}) {
  let command, cancel;
  joinExtension(
    {
      on: () => {},
      registerShortcut: (_, value) => {
        cancel = value.handler;
      },
      registerCommand: (_, value) => {
        command = value.handler;
      },
    },
    { file: f.configFile, dir: f.config.attachmentDir },
  );
  const ctx = {
    mode: 'tui',
    hasUI: true,
    isIdle: () => true,
    hasPendingMessages: () => false,
    ui: { notify },
    switchSession,
  };
  return { start: () => command(f.id, ctx), cancel: () => cancel(ctx) };
}

test(
  'handoff cancellation after seal finishes exact shutdown without reserving a destination',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
        t,
        `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
      ),
      rpc = await f.bridge.pool.resolve(f.session),
      controller = new AbortController(),
      seal = AttachedRuntime.prototype.seal;
    f.cleanup.push(() => f.mark('shutdown-go'));
    t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
      const value = await seal.apply(this, args);
      if (value.sealed) controller.abort();
      return value;
    });
    let completed = false;
    const handoff = assert
      .rejects(
        f.bridge.handoffForLocal(f.request, { signal: controller.signal }),
        /HANDOFF_CANCELLED/,
      )
      .finally(() => {
        completed = true;
      });
    await until(() => exists(path.join(f.dir, 'shutdown')));
    assert.equal(controller.signal.aborted, true);
    assert.equal(rpc.exitSeal, 'sealed');
    assert.equal(rpc.child.stdin.writableEnded, true);
    assert.equal(completed, false);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).kind, 'rpc');
    await f.mark('shutdown-go');
    await handoff;
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
  },
);

for (const stage of ['running', 'busy_handoff', 'handoff_eof', 'release_eof'])
  test(`delete ends the session during ${stage}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(
      t,
      `
      pi.on('agent_before_settle', async()=>{await mark('settling');await wait('settle');});
      pi.on('session_shutdown', async()=>{await mark('shutdown');await wait('shutdown-go');});
    `,
    );
    f.cleanup.push(() => Promise.all([f.mark('settle'), f.mark('shutdown-go')]));
    f.config.attachmentExitTimeoutMs = 50;
    await f.bridge.send({ session_id: f.id, text: 'DELETE_OVERRIDES_LIFECYCLE' });
    const rpc = f.bridge.pool.get(f.id),
      owner = structuredClone(rpc.ownerRecord.owner);
    await until(() => exists(path.join(f.dir, 'settling')));
    let lifecycle;
    if (stage === 'release_eof') {
      // Exercise explicit local release rather than racing automatic release.
      rpc.autoReleaseWanted = false;
      await rpc.autoReleaseTask;
      await f.mark('settle');
      await rpc.waitForHandoff();
      lifecycle = f.bridge.releaseForLocal({ session_id: f.id });
    } else if (stage !== 'running') lifecycle = transfer(f);
    const outcome = lifecycle?.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (lifecycle) await until(() => Boolean(f.bridge.handoff(f.id)));
    if (stage === 'handoff_eof') await f.mark('settle');
    if (['handoff_eof', 'release_eof'].includes(stage))
      await until(() => exists(path.join(f.dir, 'shutdown')));
    const deleted = await f.bridge.delete({ session_id: f.id });
    assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
    if (outcome)
      assert.ok((await outcome).error, 'cancelled lifecycle must not report a successful handoff');
    assert.equal(await ownerAlive(owner), false);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    assert.equal(Boolean(f.bridge.handoff(f.id)), false);
    await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
    const manifest = await restoreManifest(f.config, deleted);
    assert.match(await fs.readFile(manifest.trash_path, 'utf8'), /DELETE_OVERRIDES_LIFECYCLE/);
  });

test(
  'an uncertain stop ACK remains a handoff barrier even after the stop lock ends',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session),
      receive = rpc.receiveResponse;
    let held;
    t.mock.method(rpc, 'receiveResponse', function (event, generation) {
      if (event.type === 'response' && event.command === 'abort') {
        held = { event, generation };
        return;
      }
      return receive.call(this, event, generation);
    });
    ackTimeout(t, ['abort']);
    const args = { session_id: f.id },
      receipt = await f.bridge.stop(args);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.reason, 'ACK_TIMEOUT');
    await until(() => held);
    assert.equal(f.bridge.lane(f.id, 'stop'), undefined);
    const joined = transfer(f);
    await until(() => rpc.handoffPending);
    await delay(100);
    assert.equal(rpc.gracefulExitPromise, undefined);
    assert.equal(rpc.alive, true);

    receive.call(rpc, held.event, held.generation);
    assert.equal((await joined).status, 'reserved');
    assert.equal(rpc.child.exitCode, 0);
    await cancel(f);
  },
);

test(
  'disconnect cancellation before EOF resumes admissions, preserves the current run and permits a single new join',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});`,
    );
    f.cleanup.push(() => f.mark('settle'));
    await f.bridge.send({ session_id: f.id, text: 'CANCEL_WAIT' });
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
    const controller = new AbortController(),
      joined = transfer(f, { signal: controller.signal });
    const rejected = assert.rejects(joined, /HANDOFF_CANCELLED/);
    await until(() => rpc.handoffPending);
    await assert.rejects(transfer(f), /HANDOFF_PENDING/);
    await ownerRequest(f.config, { ...f.request, op: 'handoff_cancel', handoff_id: randomUUID() });
    assert.equal(rpc.handoffPending, true);
    controller.abort();
    await rejected;
    await until(() => !f.bridge.handoff(f.id));
    assert.equal(await ownerAlive(old.owner), true);
    assert.notEqual((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          text: 'PRESERVED_QUEUE',
          mode: 'follow_up',
        })
      ).status,
      'queued',
    );
    f.request.handoff_id = randomUUID();
    const retried = transfer(f);
    await f.mark('settle');
    assert.equal((await retried).status, 'reserved');
    await cancel(f);
  },
);

for (const action of ['cancel', 'delete'])
  test(`${action} during reservation validation never starts native switching or terminates the requester`, async (t) => {
    const f = await fixture(t);
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      open = fs.open,
      file = claimFile(f.config.attachmentDir, f.session);
    await f.bridge.releaseForLocal({ session_id: f.id });
    let gated = false,
      switches = 0;
    t.mock.method(fs, 'open', async function (target, ...args) {
      if (target === file && !gated) {
        let record;
        try {
          record = JSON.parse(readFileSync(file, 'utf8'));
        } catch {}
        // The first read after owner control publishes the reservation is the
        // companion's asynchronous validation, after it received the response.
        if (record?.phase === 'reserved' && record.handoffId) {
          gated = true;
          entered.resolve();
          await release.promise;
        }
      }
      return open.call(this, target, ...args);
    });
    const local = join(f, async () => {
      switches++;
      return { cancelled: true };
    });
    try {
      const joined = local.start();
      await entered.promise;
      if (action === 'delete') {
        const deleted = await f.bridge.delete({ session_id: f.id });
        assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
        assert.equal(await ownerAlive(f.request.requester), true);
        await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
      } else await local.cancel();
      release.resolve();
      await joined;
      assert.equal(switches, 0);
      const claim = await readClaim(f.config.attachmentDir, f.session);
      if (action === 'delete') assert.equal(claim, null);
      else {
        assert.equal(claim.phase, 'released');
        assert.equal(claim.noColdReacquire, true);
        await assert.rejects(f.bridge.pool.resolve(f.session), /COLD_REACQUIRE_BLOCKED/);
      }
    } finally {
      release.resolve();
      t.mock.restoreAll();
    }
  });

test('an uncertain native switch exception retains its live reservation instead of allowing a second writer', async (t) => {
  const f = await fixture(t),
    notices = [];
  await join(
    f,
    async () => {
      throw new Error('fixture failure after target open');
    },
    (text) => notices.push(text),
  ).start();
  const held = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(held.kind, 'handoff');
  assert.equal(held.phase, 'opening');
  assert.equal(held.owner.pid, process.pid);
  assert.ok(notices.some((x) => x.includes('reservation is retained')));
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
  f.request.handoff_id = held.handoffId;
  await cancel(f);
});

test('delete holds exclusion through an opening handoff until the requester exits', async (t) => {
  const f = await fixture(t);
  const { child, exited, owner } = await idleProcess(t);
  f.request.requester = owner;
  await transfer(f);
  const dir = f.config.attachmentDir;
  const claim = await readClaim(dir, f.session);
  await updateOwner(dir, f.session, claim, { phase: 'opening' });
  const deleting = f.bridge.delete({ session_id: f.id });
  await until(async () => {
    try {
      await assertNoOtherLiveOwner(dir, f.session);
      return false;
    } catch (error) {
      if (error.code !== 'LIVE_OWNER_UNREACHABLE') throw error;
      return true;
    }
  });
  assert.equal(await ownerAlive(f.request.requester), true);
  assert.ok(await fs.stat(f.session.file));
  child.kill();
  await exited;
  assert.equal((await deleting).status, 'deleted');
  await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
});

test(
  'a native TUI joins after the owned writer commits its final history',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `
    pi.on('agent_before_settle', async () => { await mark('settling'); await wait('settle'); });
    pi.on('session_shutdown', () => pi.appendEntry('final-owned-history', {}));
  `,
    );
    f.cleanup.push(() => f.mark('settle'));
    const second = await f.bridge.session((await savedSession(f.bridge)).session_id);
    const tui = await nativeTui(
      { ...f, config: { ...f.config, piArgs: isolatedRuntime(f.dir).piArgs } },
      second,
    );
    const denied = await f.bridge.send({ session_id: second.id, text: '/bridge-join ' + f.id });
    assert.equal(denied.reason, 'OWNER_LOCAL_COMMAND_REQUIRED');

    await f.bridge.send({ session_id: f.id, text: 'NATIVE_JOIN_LATEST' });
    await until(() => exists(path.join(f.dir, 'settling')));
    const original = (await readClaim(f.config.attachmentDir, f.session)).owner;
    tui.type('/bridge-join ' + f.id + '\r');
    await until(() => Boolean(f.bridge.handoff(f.id)));
    assert.equal(await ownerAlive(original), true);
    await f.mark('settle');
    await until(async () => {
      const claim = await readClaim(f.config.attachmentDir, f.session);
      return claim?.phase === 'ready' && claim.owner.pid === tui.owner.pid;
    }, 'TUI resumed the target');
    assert.equal(await ownerAlive(original), false);
    const saved = await fs.readFile(f.session.file, 'utf8');
    assert.match(saved, /final-owned-history/);
    assert.match(saved, /NATIVE_JOIN_LATEST/);
  },
);
