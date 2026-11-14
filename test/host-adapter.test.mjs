import { ownerEnvelope } from '../src/attachment-protocol.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { READ_CONTRACT } from '../src/context-read.mjs';
import {
  readClaim,
  claimFile,
  ownerAlive,
  reserveOwner,
  updateOwner,
  AttachedRuntime,
} from '../src/attachments.mjs';
import { Bridge } from '../src/bridge.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-host-')),
    file = path.join(dir, 'sessions', 'session.jsonl'),
    header = {
      type: 'session',
      version: 3,
      id: 'native-fixture',
      cwd: dir,
      timestamp: new Date().toISOString(),
    };
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(file, JSON.stringify(header) + '\n', { mode: 0o600 });
  const session = { file, header },
    attachmentDir = path.join(dir, 'ipc'),
    controller = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir,
      session,
    });
  t.after(async () => {
    await controller.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const state = () => ({
    sessionFile: file,
    sessionId: header.id,
    isIdle: true,
    isStreaming: false,
  });
  const snapshot = () => ({
    ...state(),
    entries: [
      {
        type: 'message',
        id: 'u',
        parentId: null,
        message: { role: 'user', content: 'PUBLIC_FIXTURE' },
      },
    ],
    leafId: 'u',
  });
  const callbacks = {
    state,
    snapshot,
    submit: async () => ({ status: 'accepted', disposition: 'started' }),
  };
  return { dir, session, attachmentDir, controller, callbacks };
}
async function observingBridge(f) {
  return new Bridge(
    {
      stateDir: path.join(f.dir, 'state'),
      attachmentDir: f.attachmentDir,
      sessionRoots: [path.dirname(f.session.file)],
      folders: [],
      defaults: { ...denyAllPermissions(), list: true },
    },
    async () => {
      throw new Error('UNEXPECTED_SECOND_WRITER');
    },
  ).init();
}
function request(f, op, body = {}, changes = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(f.controller.record.socket);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('test timeout'));
    });
    socket.on('error', reject);
    socket.on('connect', () =>
      socket.write(ownerEnvelope(f.controller.record, { op, body, ...changes })),
    );
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'),
          response = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (!response.partial) {
          socket.destroy();
          resolve(response);
          return;
        }
      }
    });
  });
}

test('host reload never reports failed native work or a changed session as completed', async (t) => {
  const f = await fixture(t);
  let reloads = 0,
    changed = false;
  await f.controller.ready({
    ...f.callbacks,
    state: () => ({
      ...f.callbacks.state(),
      ...(changed ? { sessionId: 'another-native-session' } : {}),
    }),
    reload: async ({ beforeDispatch }) => {
      beforeDispatch();
      if (++reloads === 1) throw new Error('native reload failed');
      changed = true;
      return { reloaded: true };
    },
  });
  const runtime = new AttachedRuntime(
    { attachmentDir: f.attachmentDir },
    f.session,
    f.controller.record,
  );
  await assert.rejects(runtime.reload(), { code: 'RELOAD_UNCONFIRMED', uncertain: true });
  assert.equal(reloads, 1); // No automatic replay after native dispatch.
  await assert.rejects(runtime.reload(), { code: 'RELOAD_UNCONFIRMED', uncertain: true });
  assert.equal(reloads, 2);
});

test('a protocol mismatch blocks attachment and replacement without retiring the live claim', async (t) => {
  const f = await fixture(t);
  await f.controller.ready(f.callbacks);
  const record = await readClaim(f.attachmentDir, f.session);
  await fs.writeFile(
    claimFile(f.attachmentDir, f.session),
    JSON.stringify({ ...record, unexpected: true }),
  );
  const bridge = await observingBridge(f);
  try {
    await assert.rejects(bridge.pool.forRead(f.session), /ATTACHMENT_PROTOCOL_MISMATCH/);
    await assert.rejects(reserveOwner(f.attachmentDir, f.session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
    assert.equal(await ownerAlive(record.owner), true);
  } finally {
    await fs.writeFile(claimFile(f.attachmentDir, f.session), JSON.stringify(record));
    await bridge.close();
  }
});

test('two-phase host reservation blocks another writer before ready and exposes bounded live reads', async (t) => {
  const f = await fixture(t);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'starting');
  await assert.rejects(reserveOwner(f.attachmentDir, f.session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
  await f.controller.ready(f.callbacks);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'ready');
  const read = await request(f, 'read', { session_id: 'fixture' });
  assert.ok(JSON.stringify(read.data).includes('PUBLIC_FIXTURE'));
  assert.equal(read.data.contract, READ_CONTRACT);
  const observed = await request(f, 'read', { session_id: 'fixture', view: 'runtime' });
  assert.equal(observed.data.observation.reason, 'host_observer_unavailable');
  assert.deepEqual(observed.data.units, []);
  assert.equal((await request(f, 'state')).data.sessionId, f.session.header.id);
  await assert.rejects(
    new AttachedRuntime(
      { attachmentDir: f.attachmentDir },
      f.session,
      f.controller.record,
    ).selectModel(undefined, { thinkingLevel: 'high' }),
    /MODEL_SELECTION_UNSUPPORTED/,
  );
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'unknown' })).error,
    'INVALID_ATTACHED_SEND',
  );
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'steer' })).data.status,
    'accepted',
  );
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'steer' }, { generation: 'stale' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
});

test('host state requires the current boolean capability declaration', async (t) => {
  const f = await fixture(t);
  let capabilities;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.once('data', () =>
      socket.end(
        ownerEnvelope(f.controller.record, { data: { ...f.callbacks.state(), capabilities } }),
      ),
    );
  });
  await new Promise((resolve) => server.listen(f.controller.record.socket, resolve));
  await updateOwner(f.attachmentDir, f.session, f.controller.record, { phase: 'ready' });
  const runtime = new AttachedRuntime(
    { attachmentDir: f.attachmentDir },
    f.session,
    f.controller.record,
  );
  try {
    for (const declared of [
      undefined,
      {},
      { send: true, command: null, stop: null },
      { send: true, command: 'true', stop: 1 },
    ]) {
      capabilities = declared;
      await assert.rejects(runtime.state(), /OWNER_COMPONENT_UPDATE_REQUIRED/);
    }
    capabilities = { send: true, command: false, stop: true };
    assert.deepEqual((await runtime.state()).capabilities, capabilities);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('host cancel drains preparation and native bash without a remote stop callback', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    bashEntered = gate(),
    finished = gate();
  let closed = false,
    cancels = 0;
  f.callbacks.submit = async () => {
    entered.resolve();
    await finished.promise;
    assert.equal(closed, false);
    return { status: 'unknown' };
  };
  f.callbacks.bash = async ({ onResult }) => {
    bashEntered.resolve();
    await finished.promise;
    assert.equal(closed, false);
    const result = { output: 'cancelled', exitCode: null, cancelled: true, truncated: false };
    await onResult(result);
    return result;
  };
  f.callbacks.cancel = async () => {
    cancels++;
    finished.resolve();
  };
  f.callbacks.release = async () => {
    closed = true;
    return { released: true };
  };
  await f.controller.ready(f.callbacks);
  const sending = request(f, 'send', { text: 'preparing', mode: 'steer' });
  let bashing, releasing;
  try {
    assert.equal(
      await Promise.race([entered.promise.then(() => true), sending.then(() => false)]),
      true,
    );
    bashing = request(f, 'bash', { command: 'synthetic active bash' });
    assert.equal(
      await Promise.race([bashEntered.promise.then(() => true), bashing.then(() => false)]),
      true,
    );
    releasing = f.controller.release();
    await sending;
    assert.equal((await bashing).data.cancelled, true);
    await releasing;
    assert.equal(cancels, 1);
    assert.equal(closed, true);
  } finally {
    finished.resolve();
    await Promise.allSettled([sending, bashing, releasing]);
  }
});
test('confirmed writer closure is not repeated when claim cleanup is explicitly retried', async (t) => {
  const f = await fixture(t);
  let releases = 0,
    failCleanup = true;
  f.callbacks.release = async () => {
    releases++;
    return { released: true };
  };
  await f.controller.ready(f.callbacks);
  const unlink = fs.unlink,
    file = claimFile(f.attachmentDir, f.session);
  t.mock.method(fs, 'unlink', async function (target, ...args) {
    if (target === file && failCleanup) {
      failCleanup = false;
      throw Object.assign(new Error('fixture cleanup failure'), { code: 'EIO' });
    }
    return unlink.call(this, target, ...args);
  });
  try {
    await assert.rejects(f.controller.release(), { code: 'EIO' });
    assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'transitioning');
    assert.equal(releases, 1);
    assert.equal((await f.controller.release()).released, true);
    assert.equal(await readClaim(f.attachmentDir, f.session), null);
    assert.equal(releases, 1);
  } finally {
    t.mock.restoreAll();
  }
});

test('identity is checked after asynchronous host submission', async (t) => {
  const f = await fixture(t);
  let changed = false;
  const state = f.callbacks.state;
  f.callbacks.state = () => ({
    ...state(),
    sessionId: changed ? 'different' : f.session.header.id,
  });
  f.callbacks.submit = async () => {
    changed = true;
    return { status: 'accepted', disposition: 'started' };
  };
  await f.controller.ready(f.callbacks);
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'steer' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
  assert.ok(await readClaim(f.attachmentDir, f.session));
});
test('close during readiness verification cannot publish a new endpoint', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    finish = gate(),
    state = f.callbacks.state;
  f.callbacks.state = async () => {
    entered.resolve();
    await finish.promise;
    return state();
  };
  const publishing = f.controller.ready(f.callbacks);
  await entered.promise;
  await f.controller.close();
  finish.resolve();
  await assert.rejects(publishing, /RUNTIME_SESSION_CHANGED/);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'transitioning');
  await assert.rejects(fs.stat(f.controller.record.socket), { code: 'ENOENT' });
});
test('read snapshots are detached before awaited identity checks and later host mutations', async (t) => {
  const f = await fixture(t),
    snapshot = f.callbacks.snapshot(),
    before = JSON.stringify(snapshot.entries);
  let reads = 0;
  f.callbacks.snapshot = () => snapshot;
  const state = f.callbacks.state;
  f.callbacks.state = () => {
    reads++;
    if (reads === 4) snapshot.entries[0].message.content = 'LATER_MUTATION';
    return state();
  };
  await f.controller.ready(f.callbacks); // two state verifications
  const result = await request(f, 'read', { session_id: 'fixture' });
  assert.equal(reads, 4);
  assert.notEqual(JSON.stringify(snapshot.entries), before);
  assert.ok(JSON.stringify(result.data).includes('PUBLIC_FIXTURE'));
  assert.ok(!JSON.stringify(result.data).includes('LATER_MUTATION'));
});
test('publication failure after listening closes endpoint while retaining ownership', async (t) => {
  const f = await fixture(t),
    state = f.callbacks.state;
  let calls = 0;
  f.callbacks.state = () => {
    calls++;
    return calls === 1 ? state() : { ...state(), sessionId: 'changed' };
  };
  await assert.rejects(f.controller.ready(f.callbacks), /RUNTIME_SESSION_CHANGED/);
  assert.ok(await readClaim(f.attachmentDir, f.session));
  await assert.rejects(request(f, 'state'));
});
