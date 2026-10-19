import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { readClaim, reserveOwner, processIdentity, AttachedRuntime } from '../src/attachments.mjs';
const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-host-')),
    file = path.join(dir, 'session.jsonl'),
    header = {
      type: 'session',
      version: 3,
      id: 'native-fixture',
      cwd: dir,
      timestamp: new Date().toISOString(),
    };
  await fs.writeFile(file, JSON.stringify(header) + '\n', { mode: 0o600 });
  const session = { file, header },
    attachmentDir = path.join(dir, 'ipc'),
    controller = await reserveHostSession({ attachmentDir, session });
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
      socket.write(
        JSON.stringify({
          op,
          body,
          file: f.session.file,
          sessionId: f.session.header.id,
          generation: f.controller.record.generation,
          ...changes,
        }) + '\n',
      ),
    );
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffer.slice(0, buffer.indexOf('\n'))));
      }
    });
  });
}
test('model selection extends the IPC deadline to the requested ACK budget', async (t) => {
  const f = await fixture(t),
    deadlines = [],
    setTimeout = net.Socket.prototype.setTimeout;
  f.callbacks.selectModel = async () => ({
    model: { provider: 'p', id: 'm' },
    thinking_level: 'off',
    thinking_adjustment: 'none',
  });
  await f.controller.ready(f.callbacks);
  t.mock.method(net.Socket.prototype, 'setTimeout', function (ms, ...args) {
    if (this.server?.address?.() === f.controller.record.socket) deadlines.push(ms);
    return setTimeout.call(this, ms, ...args);
  });
  const runtime = new AttachedRuntime(
    { attachmentDir: f.attachmentDir },
    f.session,
    f.controller.record,
  );
  const result = await runtime.set_model({ model: { provider: 'p', id: 'm' }, timeout_ms: 14000 });
  assert.equal(result.status, 'accepted');
  assert.deepEqual(deadlines, [5000, 14000]);
});

test('two-phase host reservation blocks another writer before ready and exposes bounded live reads', async (t) => {
  const f = await fixture(t);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'starting');
  await assert.rejects(reserveOwner(f.attachmentDir, f.session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
  await f.controller.ready(f.callbacks);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'ready');
  const read = await request(f, 'read', { session_id: 'fixture' });
  assert.ok(JSON.stringify(read.data).includes('PUBLIC_FIXTURE'));
  assert.equal(read.data.format, 'context_timeline');
  assert.equal(
    (await request(f, 'read', { session_id: 'fixture', view: 'raw' })).error,
    'INVALID_READ_ARGUMENTS',
  );
  assert.equal((await request(f, 'state')).data.sessionId, f.session.header.id);
  for (const mode of ['native', 'queue'])
    assert.equal(
      (await request(f, 'send', { text: 'fixture', mode })).error,
      'INVALID_ATTACHED_SEND',
    );
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'default' })).data.status,
    'accepted',
  );
  assert.equal(
    (await request(f, 'send', { text: 'fixture', mode: 'default' }, { generation: 'stale' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
});
test('cooperative public reads stay bounded while fork snapshots preserve full native entries', async (t) => {
  const f = await fixture(t),
    snapshot = f.callbacks.snapshot();
  snapshot.entries[0].message.content = 'NATIVE_RAW_INPUT ' + 'x'.repeat(120000);
  f.callbacks.snapshot = () => snapshot;
  await f.controller.ready(f.callbacks);
  const runtime = new AttachedRuntime(
    { attachmentDir: f.attachmentDir },
    f.session,
    f.controller.record,
  );
  const result = await runtime.read({ session_id: 'public-fixture', max_bytes: 4096 });
  assert.equal(result.format, 'context_timeline');
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
  const raw = await runtime.snapshot();
  assert.equal(raw.entries[0].message.content, snapshot.entries[0].message.content);
  assert.equal(raw.leafId, 'u');
  assert.equal(raw.sessionId, f.session.header.id);
  t.mock.method(runtime, 'request', async () => ({ items: [], next_cursor: null }));
  await assert.rejects(
    runtime.read({ session_id: 'public-fixture', max_bytes: 4096 }),
    /OWNER_READ_REFRESH_REQUIRED/,
  );
});
test('host state forwards only validated nonnegative integer pending counts', async (t) => {
  const f = await fixture(t),
    state = f.callbacks.state;
  let count;
  f.callbacks.state = () => ({
    ...state(),
    ...(count === undefined ? {} : { pendingMessageCount: count }),
  });
  await f.controller.ready(f.callbacks);
  for (const [input, expected] of [
    [0, 0],
    [3, 3],
    [undefined, null],
    [-1, null],
    [1.5, null],
    ['3', null],
    [null, null],
    [NaN, null],
    [Infinity, null],
    [Number.MAX_SAFE_INTEGER + 1, null],
  ]) {
    count = input;
    assert.equal((await request(f, 'state')).data.pendingMessageCount, expected);
  }
});
test('host release waits for admitted preparation, fences new input, and releases shared PID without killing it', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    finish = gate();
  let released = false;
  f.callbacks.submit = async () => {
    entered.resolve();
    await finish.promise;
    assert.equal(released, false);
    return { status: 'unknown' };
  };
  f.callbacks.release = async () => {
    released = true;
    return { released: true };
  };
  await f.controller.ready(f.callbacks);
  const sending = request(f, 'send', { text: 'fixture', mode: 'default' });
  await entered.promise;
  const releasing = f.controller.release();
  assert.ok(await readClaim(f.attachmentDir, f.session));
  assert.equal(released, false);
  assert.equal(
    (await request(f, 'send', { text: 'second', mode: 'default' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
  finish.resolve();
  assert.equal((await sending).data.status, 'unknown');
  assert.deepEqual(await releasing, { released: true, generation: f.controller.record.generation });
  assert.equal(await readClaim(f.attachmentDir, f.session), null);
  assert.ok(await processIdentity());
});
test('release cancels native bash before draining admitted result capture and closing the writer', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    cancelled = gate(),
    captureEntered = gate(),
    captureFinish = gate();
  let closed = false,
    stops = 0;
  f.callbacks.bash = async ({ onResult }) => {
    entered.resolve();
    await cancelled.promise;
    await onResult({ output: 'cancelled', exitCode: null, cancelled: true, truncated: false });
    captureEntered.resolve();
    await captureFinish.promise;
    assert.equal(closed, false);
    return { completed: true };
  };
  f.callbacks.stop = async ({ onWithdraw }) => {
    stops++;
    cancelled.resolve();
    await onWithdraw({ steering: [], followUp: [] });
    return { acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
  };
  f.callbacks.release = async () => {
    closed = true;
    return { released: true };
  };
  await f.controller.ready(f.callbacks);
  const bashing = request(f, 'bash', {
    command: 'synthetic active bash',
    recovery_id: 'a'.repeat(64),
  });
  await entered.promise;
  const releasing = request(f, 'release');
  await captureEntered.promise;
  assert.equal(stops, 1);
  assert.equal(closed, false);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'transitioning');
  assert.equal(
    (await request(f, 'send', { text: 'fenced', mode: 'default' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
  captureFinish.resolve();
  assert.equal((await bashing).data.completed, true);
  assert.equal((await releasing).data.released, true);
  assert.equal(closed, true);
  assert.equal(await readClaim(f.attachmentDir, f.session), null);
});
test('explicit host cancellation releases active preparation before the writer-close callback', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    finished = gate();
  let closed = false,
    cancels = 0;
  f.callbacks.submit = async () => {
    entered.resolve();
    await finished.promise;
    assert.equal(closed, false);
    return { status: 'unknown' };
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
  const sending = request(f, 'send', { text: 'preparing', mode: 'default' });
  await entered.promise;
  const releasing = f.controller.release();
  await sending;
  await releasing;
  assert.equal(cancels, 1);
  assert.equal(closed, true);
});
test('controller close retains live writer claim and unsupported release remains explicit', async (t) => {
  const f = await fixture(t);
  await f.controller.ready(f.callbacks);
  assert.equal((await request(f, 'release')).error, 'HOST_RELEASE_UNSUPPORTED');
  await f.controller.close();
  const claim = await readClaim(f.attachmentDir, f.session);
  assert.equal(claim.phase, 'transitioning');
  assert.equal(claim.owner.pid, process.pid);
  await assert.rejects(reserveOwner(f.attachmentDir, f.session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
});
test('missing or switched native identity never publishes ready or dispatches a prompt', async (t) => {
  const f = await fixture(t);
  f.callbacks.state = () => undefined;
  await assert.rejects(f.controller.ready(f.callbacks), /RUNTIME_SESSION_CHANGED/);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'starting');
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
    (await request(f, 'send', { text: 'fixture', mode: 'default' })).error,
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
test('malformed host snapshot identity fields cannot become a read response', async (t) => {
  const f = await fixture(t),
    snapshot = f.callbacks.snapshot();
  f.callbacks.snapshot = () => ({ ...snapshot, leafId: 42 });
  await f.controller.ready(f.callbacks);
  assert.equal(
    (await request(f, 'read', { session_id: 'fixture' })).error,
    'INVALID_HOST_SNAPSHOT',
  );
  f.callbacks.snapshot = () => ({ ...snapshot, entries: [{ id: 4 }] });
  assert.equal(
    (await request(f, 'read', { session_id: 'fixture' })).error,
    'INVALID_HOST_SNAPSHOT',
  );
});
test('successful IPC release flushes its acknowledgment and retires the listener without closing the host', async (t) => {
  const f = await fixture(t);
  f.callbacks.release = async () => ({ released: true });
  await f.controller.ready(f.callbacks);
  const result = await request(f, 'release');
  assert.deepEqual(result.data, { released: true, generation: f.controller.record.generation });
  assert.equal(await readClaim(f.attachmentDir, f.session), null);
  await assert.rejects(request(f, 'state'));
  assert.ok(await processIdentity());
  await f.controller.close();
  await f.controller.close();
});
