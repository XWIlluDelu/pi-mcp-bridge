import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
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

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

test('reload requires send and leaves saved sessions and explicit local pauses unopened', async (t) => {
  const f = await fixture(t);
  const session = await f.bridge.session(f.id);
  const before = await fs.readFile(session.file, 'utf8');
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'skipped',
    reason: 'no_active_owner',
  });
  assert.equal(f.bridge.pool.instances.size, 0);
  await f.bridge.releaseForLocal({ session_id: f.id });
  const claim = await readClaim(f.bridge.pool.attachmentDir, session);
  assert.equal(claim.noColdReacquire, true);
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'skipped',
    reason: 'no_active_owner',
  });
  assert.deepEqual(await readClaim(f.bridge.pool.attachmentDir, session), claim);
  assert.equal(await fs.readFile(session.file, 'utf8'), before);
  await fs.writeFile(
    f.configFile,
    JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, read: true }] }),
  );
  await assert.rejects(f.bridge.reload({ session_id: f.id }), /NOT_FOUND_OR_DENIED/);
});

test('idle owned reload confirms a fresh worker without sending input or rewriting saved history', async (t) => {
  const f = await fixture(t);
  const session = await f.bridge.session(f.id);
  const old = await f.bridge.pool.resolve(session);
  const before = await savedEntries(f.bridge, f.id);
  const start = f.bridge.pool.factory;
  let fresh;
  f.bridge.pool.factory = async (...args) => (fresh = await start(...args));
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'completed',
    owner_version: READ_CONTRACT,
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
    session = await f.bridge.session(f.id),
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

test('reload refuses input preflight and running work without aborting either', async (t) => {
  const f = await fixture(t);
  const pending = f.bridge.send({ session_id: f.id, text: 'HOLD_PREFLIGHT' });
  await until(() => exists(f.gate + '.preflight-start'));
  const preflightOwner = f.bridge.pool.get(f.id);
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'rejected',
    reason: 'RELOAD_BUSY',
  });
  assert.equal(preflightOwner.exited, false);
  await fs.writeFile(f.gate + '.preflight-release', 'continue');
  await pending;
  await until(() => !f.bridge.pool.get(f.id));
  await f.bridge.send({ session_id: f.id, text: 'HOLD_MODEL' });
  await until(() => exists(f.gate + '.provider-start'));
  const active = f.bridge.pool.get(f.id);
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'rejected',
    reason: 'RELOAD_BUSY',
  });
  assert.equal(active.exited, false);
  assert.equal((await active.state()).isStreaming, true);
  assert.equal(await exists(f.gate + '.provider-aborted'), false);
  await fs.writeFile(f.gate, 'continue');
  await until(() => !f.bridge.pool.get(f.id));
});

// Exercise the actual owner socket, loss of its ACK, and generation publication.
// Native companion reload itself is exercised by the companion integration tests.
async function attached(
  t,
  {
    supported = true,
    error,
    loseAck = false,
    version = READ_CONTRACT,
    replaceIdentity = false,
    leaveUnchanged = false,
    initializing = false,
    invalidReplacement = false,
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
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', async (data) => {
      buffer += data;
      if (!buffer.includes('\n')) return;
      const req = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      buffer = '';
      const respond = (value) =>
        socket.end(JSON.stringify({ generation: req.generation, ...value }) + '\n');
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
      if (error) return respond({ error });
      if (leaveUnchanged) return respond({ data: { reloading: true } });
      current = {
        ...record,
        generation: randomUUID(),
        phase: 'ready',
        readContract: version,
        ...(replaceIdentity ? { sessionId: 'different-native-session' } : {}),
      };
      if (invalidReplacement) await fs.writeFile(claimFile(dir, session), '{');
      else await atomicJson(claimFile(dir, session), current);
      if (loseAck) socket.destroy();
      else respond({ data: { reloading: true } });
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  await fs.chmod(socketPath, 0o600);
  await updateOwner(dir, session, record, {
    socket: socketPath,
    phase: 'ready',
    mode: 'rpc',
    readContract: READ_CONTRACT,
    ...(supported ? { reloadSupported: true } : {}),
  });
  // Cleanup registered after fixture cleanup runs first, so do not rely on the
  // directory still existing; close the socket independently of claim deletion.
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    ...f,
    session,
    record,
    current: () => current,
    reloads: () => reloads,
    stateReads: () => stateReads,
    completeInitialization: () => {
      initializing = false;
    },
  };
}

test('attached reload confirms replacement after a lost ACK and reports an old loaded version honestly', async (t) => {
  const f = await attached(t, { loseAck: true, version: '0.7.0-dev.2' });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'completed',
    owner_version: '0.7.0-dev.2',
    read_compatible: false,
  });
  assert.equal(f.reloads(), 1);
});

test('attached reload does not confuse a different native session with successful refresh', async (t) => {
  const f = await attached(t, { replaceIdentity: true });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'unknown',
    reason: 'RELOAD_UNCONFIRMED',
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

test('native reload busy rejection remains a definite rejection', async (t) => {
  const f = await attached(t, { error: 'RELOAD_IN_PROGRESS' });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'rejected',
    reason: 'RELOAD_BUSY',
  });
  assert.equal(f.reloads(), 1);
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
    owner_version: READ_CONTRACT,
    read_compatible: true,
  });
});

test('failure to read replacement ownership after dispatch is an unknown outcome', async (t) => {
  const f = await attached(t, { invalidReplacement: true });
  assert.deepEqual(await f.bridge.reload({ session_id: f.id }), {
    status: 'unknown',
    reason: 'RELOAD_UNCONFIRMED',
  });
  assert.equal(f.reloads(), 1);
});
