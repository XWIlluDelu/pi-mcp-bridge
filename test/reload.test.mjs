import { attachmentServer, listenPrivate, ownerEnvelope } from '../src/attachment-protocol.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture, until, savedEntries } from './fixtures/model-runtime.mjs';
import { READ_CONTRACT } from '../src/context-read.mjs';
import { atomicJson } from '../src/storage.mjs';
import {
  reserveOwner,
  updateOwner,
  readClaim,
  claimFile,
  AttachedRuntime,
} from '../src/attachments.mjs';

test('reload requires send and leaves saved sessions and explicit local pauses unopened', async (t) => {
  const f = await fixture(t),
    args = { session_id: f.id };
  const claim = () => readClaim(f.config.attachmentDir, f.session);
  assert.equal((await f.bridge.reload(args)).reason, 'no_active_owner');
  await f.bridge.releaseForLocal(args);
  const held = await claim();
  assert.equal(held.noColdReacquire, true);
  assert.equal((await f.bridge.reload(args)).reason, 'no_active_owner');
  assert.deepEqual(await claim(), held);
  assert.equal(f.bridge.pool.instances.size, 0);
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
  await assert.rejects(f.bridge.reload(args), /NOT_FOUND_OR_DENIED/);
});

test('idle owned reload confirms a fresh worker without sending input or rewriting saved history', async (t) => {
  const f = await fixture(t);
  const { session } = f;
  const old = await f.bridge.pool.resolve(session);
  const before = await savedEntries(f.bridge, f.id);
  const start = f.bridge.pool.factory;
  let fresh;
  f.bridge.pool.factory = async (...args) => (fresh = await start(...args));
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'completed',
    owner_version: packageInfo.version,
    read_compatible: true,
  });
  assert.equal(old.exited, true);
  assert.ok(fresh && fresh.child.pid !== old.child.pid);
  assert.notEqual(fresh.generation, old.generation);
  await until(() => !f.bridge.pool.get(f.id));
  const after = await savedEntries(f.bridge, f.id);
  assert.deepEqual(after.slice(0, before.length), before);
  // A native reopen may append restored model/thinking settings, never a prompt.
  assert.ok(
    after
      .slice(before.length)
      .every((e) => ['model_change', 'thinking_level_change'].includes(e.type)),
  );
});

test('reload cancellation after seal closes the old writer without starting a successor', async (t) => {
  const f = await fixture(t),
    session = f.session,
    rpc = await f.bridge.pool.resolve(session),
    seal = AttachedRuntime.prototype.seal;
  let starts = 0;
  const factory = f.bridge.pool.factory;
  f.bridge.pool.factory = (...args) => {
    starts++;
    return factory(...args);
  };
  t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
    const result = await seal.apply(this, args);
    if (result.sealed) f.bridge.handoffs.get(f.id).controller.abort();
    return result;
  });
  assert.equal((await f.bridge.reload({ session_id: f.id })).status, 'unknown');
  assert.equal(rpc.exited, true);
  assert.equal(rpc.child.exitCode, 0);
  assert.equal(starts, 0);
  assert.equal(await readClaim(f.bridge.pool.attachmentDir, session), null);
});

// Exercise the actual owner socket, loss of its ACK, and generation publication.
// Native companion reload itself is exercised by the companion integration tests.
async function attached(
  t,
  {
    supported = true,
    loseAck = false,
    version = packageInfo.version,
    contract = READ_CONTRACT,
    leaveUnchanged = false,
    initializing = false,
  } = {},
) {
  const f = await fixture(t);
  const session = await f.bridge.session(f.id),
    dir = f.bridge.pool.attachmentDir;
  const record = await reserveOwner(dir, session, 'extension');
  let current = record,
    reloads = 0,
    stateReads = 0;
  const socketPath = path.join(dir, `reload-${randomUUID().slice(0, 8)}.sock`);
  const sockets = new Set();
  const server = attachmentServer(sockets, async (frame, socket) => {
    const req = JSON.parse(frame);
    const respond = (value) => socket.end(ownerEnvelope(req, value));
    if (req.op === 'state') {
      stateReads++;
      return respond({
        data: {
          sessionFile: session.file,
          sessionId: session.header.id,
          isStreaming: false,
          reloadComplete: !initializing,
          generation: current.generation,
        },
      });
    }
    assert.equal(req.op, 'reload');
    reloads++;
    if (leaveUnchanged) return respond({ data: { reloading: true } });
    current = {
      ...record,
      generation: randomUUID(),
      phase: 'ready',
      bridgeVersion: version,
      readContract: contract,
    };
    await atomicJson(claimFile(dir, session), current);
    if (loseAck) socket.destroy();
    else respond({ data: { reloading: true } });
  });
  await listenPrivate(server, socketPath);
  await updateOwner(dir, session, record, {
    socket: socketPath,
    phase: 'ready',
    mode: 'rpc',
    bridgeVersion: packageInfo.version,
    readContract: READ_CONTRACT,
    ...(supported ? { reloadSupported: true } : {}),
  });
  f.cleanup.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    ...f,
    session,
    record,
    reloads: () => reloads,
    stateReads: () => stateReads,
    completeInitialization: () => {
      initializing = false;
    },
  };
}

test('attached reload confirms replacement after a lost ACK and reports an incompatible read contract', async (t) => {
  const f = await attached(t, { loseAck: true, version: '0.0.0', contract: 'unsupported' });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'completed',
    owner_version: '0.0.0',
    read_compatible: false,
  });
  assert.equal(f.reloads(), 1);
});

test('owners without reload support are rejected before dispatch', async (t) => {
  const f = await attached(t, { supported: false });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'rejected',
    reason: 'RELOAD_UNSUPPORTED',
  });
  assert.equal(f.reloads(), 0);
});

test(
  'reload acknowledgement without a replacement stays unknown and is not replayed',
  { timeout: 15000 },
  async (t) => {
    const f = await attached(t, { leaveUnchanged: true });
    assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
      status: 'unknown',
      reason: 'RELOAD_UNCONFIRMED',
    });
    assert.equal(f.reloads(), 1);
    assert.equal(
      (await readClaim(f.bridge.pool.attachmentDir, f.session)).generation,
      f.record.generation,
    );
  },
);

test('a newly published owner must finish native initialization before reload completes', async (t) => {
  const f = await attached(t, { initializing: true });
  let finished = false;
  const work = f.bridge.reload({ session_id: f.id }).then((value) => {
    finished = true;
    return value;
  });
  await until(() => f.reloads() === 1 && f.stateReads() >= 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  f.completeInitialization();
  assert.deepEqual(await work, {
    status: 'completed',
    owner_version: packageInfo.version,
    read_compatible: true,
  });
});
