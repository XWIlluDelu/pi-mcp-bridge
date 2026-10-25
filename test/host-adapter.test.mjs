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
  processIdentity,
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
test('optional host setter verifies actual values while busy and fences unresolved native work', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate(),
    stopEntered = gate(),
    stopRelease = gate();
  const actual = { model: { provider: 'fixture', id: 'a' }, thinkingLevel: 'off' };
  t.after(() => release.resolve());
  await f.controller.ready({
    ...f.callbacks,
    state: () => ({ ...f.callbacks.state(), ...actual, isStreaming: true }),
    stop: async ({ onWithdraw }) => {
      await onWithdraw({ steering: [], followUp: [] });
      stopEntered.resolve();
      await stopRelease.promise;
      return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
    },
    setModel: async ({ model, thinking_level, beforeDispatch }) => {
      entered.resolve();
      await release.promise;
      beforeDispatch();
      actual.model = model;
      actual.thinkingLevel = thinking_level;
      return { model, thinking_level, ignoredPrivateMetadata: 'never transported' };
    },
  });
  const runtime = new AttachedRuntime(
    { attachmentDir: f.attachmentDir },
    f.session,
    f.controller.record,
  );
  const first = runtime.selectModel({ provider: 'fixture', id: 'b' }, { thinkingLevel: 'high' });
  await entered.promise;
  await assert.rejects(runtime.send({ text: 'NEVER_SUBMITTED' }), /MODEL_SELECTION_PENDING/);
  await assert.rejects(
    runtime.selectModel(undefined, { thinkingLevel: 'off' }),
    /MODEL_SELECTION_PENDING/,
  );
  release.resolve();
  assert.deepEqual(await first, {
    model: { provider: 'fixture', id: 'b' },
    thinking_level: 'high',
  });
  assert.equal((await runtime.state()).isStreaming, true);
  const stopping = runtime.stopExecution();
  await stopEntered.promise;
  try {
    assert.deepEqual(
      await runtime.selectModel({ provider: 'fixture', id: 'a' }, { thinkingLevel: 'off' }),
      { model: { provider: 'fixture', id: 'a' }, thinking_level: 'off' },
    );
    await assert.rejects(runtime.send({ text: 'NEVER_SUBMITTED' }), /STOP_IN_PROGRESS/);
  } finally {
    stopRelease.resolve();
    await stopping;
  }
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
test('host receipts preserve dispatched evidence without inventing native admission', async (t) => {
  const f = await fixture(t);
  let outcome = { status: 'dispatched', admission: 'unobservable', ignored: 'PRIVATE' };
  f.callbacks.submit = async () => outcome;
  await f.controller.ready(f.callbacks);
  assert.deepEqual((await request(f, 'send', { text: 'fixture', mode: 'steer' })).data, {
    status: 'dispatched',
    admission: 'unobservable',
  });
  for (const admission of [undefined, 'started', 'queued']) {
    outcome = { status: 'dispatched', admission };
    assert.equal(
      (await request(f, 'send', { text: 'fixture', mode: 'steer' })).error,
      'INVALID_HOST_RECEIPT',
    );
  }
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
  assert.equal(result.contract, READ_CONTRACT);
  assert.equal(
    result.units.map((unit) => unit.message.content).join(''),
    snapshot.entries[0].message.content,
  );
  assert.ok(result.units.length > 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024 * 1024);
  const raw = await runtime.snapshot();
  assert.equal(raw.entries[0].message.content, snapshot.entries[0].message.content);
  assert.equal(raw.leafId, 'u');
  assert.equal(raw.sessionId, f.session.header.id);
  t.mock.method(runtime, 'request', async () => ({
    sessionFile: f.session.file,
    sessionId: f.session.header.id,
    items: [],
    next_cursor: null,
  }));
  await assert.rejects(
    runtime.read({ session_id: 'public-fixture', max_bytes: 4096 }),
    /OWNER_READ_REFRESH_REQUIRED/,
  );
});
test('host IPC and list expose allowlisted model/thinking state under list-only permission', async (t) => {
  const f = await fixture(t),
    state = f.callbacks.state;
  let selection = {
    model: {
      provider: 'p',
      id: 'm',
      headers: { Authorization: 'SECRET' },
      apiKey: 'SECRET',
      baseUrl: 'SECRET',
    },
    thinkingLevel: 'high',
  };
  f.callbacks.state = () => ({ ...state(), ...selection });
  await f.controller.ready(f.callbacks);
  const wire = await request(f, 'state');
  assert.deepEqual(wire.data.model, { provider: 'p', id: 'm' });
  assert.equal(wire.data.thinkingLevel, 'high');
  assert.ok(!JSON.stringify(wire).includes('SECRET'));
  const bridge = await observingBridge(f);
  try {
    const { status } = (await bridge.list()).sessions[0];
    assert.deepEqual(status.model, wire.data.model);
    assert.equal(status.thinking_level, 'high');
    selection = {};
    const missing = (await bridge.list()).sessions[0].status;
    assert.equal(missing.model, null);
    assert.equal(missing.thinking_level, null);
  } finally {
    await bridge.close();
  }
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
test('list observes actual host callback support across IPC, independently of activity and grants', async (t) => {
  for (const [bash, stop, cancel] of [
    [false, false, false],
    [true, false, false],
    [false, true, false],
    [true, true, false],
    [true, false, true],
  ]) {
    await t.test(`bash=${bash}, stop=${stop}, cancel=${cancel}`, async (t) => {
      const f = await fixture(t),
        state = f.callbacks.state,
        calls = { send: 0, bash: 0, stop: 0 },
        expected = { send: true, command: bash && (cancel || stop), stop };
      let activity = {};
      f.callbacks.state = () => ({
        ...state(),
        ...activity,
        capabilities: { send: true, command: true, stop: true },
      });
      f.callbacks.submit = async () => {
        calls.send++;
        return { status: 'accepted', disposition: 'started' };
      };
      if (bash)
        f.callbacks.bash = async ({ onResult }) => {
          calls.bash++;
          await onResult({ output: 'fixture', exitCode: 0, cancelled: false, truncated: false });
          return { output: 'fixture', exitCode: 0, cancelled: false, truncated: false };
        };
      if (stop)
        f.callbacks.stop = async ({ onWithdraw }) => {
          calls.stop++;
          await onWithdraw({ steering: [], followUp: [] });
          return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
        };
      if (cancel) f.callbacks.cancel = async () => {};
      await f.controller.ready(f.callbacks);
      assert.deepEqual((await request(f, 'state')).data.capabilities, expected);
      const bridge = await observingBridge(f);
      try {
        const row = async () => (await bridge.list()).sessions[0],
          session_id = (await row()).session_id;
        for (const [observed, expectedState] of [
          [{}, 'idle'],
          [{ isIdle: undefined }, 'unknown'],
          [{ isStreaming: true }, 'busy'],
        ]) {
          activity = observed;
          const { status } = await row();
          assert.equal(status.state, expectedState);
          assert.deepEqual(status.capabilities, expected);
        }
        if (expected.command) {
          assert.equal(
            (await bridge.send({ session_id, text: 'fixture' })).reason,
            'NOT_FOUND_OR_DENIED',
          );
          await assert.rejects(
            bridge.command({ session_id, command: 'fixture' }),
            /NOT_FOUND_OR_DENIED/,
          );
          await assert.rejects(bridge.stop({ session_id }), /NOT_FOUND_OR_DENIED/);
          await assert.rejects(bridge.read({ session_id }), /NOT_FOUND_OR_DENIED/);
          assert.deepEqual(calls, { send: 0, bash: 0, stop: 0 });
          assert.deepEqual((await row()).status.capabilities, expected);
        }
        // Exercise the advertised paths without granting read.
        Object.assign(bridge.config.defaults, { send: true, command: true, stop: true });
        assert.ok(
          ['started', 'queued', 'handled'].includes(
            (await bridge.send({ session_id, text: 'fixture', mode: 'steer' })).status,
          ),
          'Expected native prompt admission',
        );
        const command = await bridge.command({
            session_id,

            command: 'fixture',
          }),
          stopped = await bridge.stop({ session_id });
        assert.equal(command.status, expected.command ? 'completed' : 'rejected');
        if (!expected.command) assert.equal(command.reason, 'BASH_UNSUPPORTED');
        assert.equal(stopped.status, stop ? 'accepted' : 'rejected');
        if (!stop) assert.equal(stopped.reason, 'STOP_UNSUPPORTED');
        assert.deepEqual(calls, { send: 1, bash: Number(expected.command), stop: Number(stop) });
        await f.controller.close();
        const { status } = await row();
        assert.equal(status.state, 'unavailable');
        assert.equal(Object.hasOwn(status, 'capabilities'), false);
      } finally {
        await bridge.close();
      }
    });
  }
});

test('host state requires the current boolean capability declaration', async (t) => {
  const f = await fixture(t);
  let capabilities;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.once('data', () =>
      socket.end(
        JSON.stringify({
          generation: f.controller.record.generation,
          data: { ...f.callbacks.state(), capabilities },
        }) + '\n',
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
  const sending = request(f, 'send', { text: 'fixture', mode: 'steer' });
  await entered.promise;
  const releasing = f.controller.release();
  assert.ok(await readClaim(f.attachmentDir, f.session));
  assert.equal(released, false);
  assert.equal(
    (await request(f, 'send', { text: 'second', mode: 'steer' })).error,
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
    return { output: 'fixture', exitCode: 0, cancelled: false, truncated: false };
  };
  f.callbacks.stop = async ({ onWithdraw }) => {
    stops++;
    cancelled.resolve();
    await onWithdraw({ steering: [], followUp: [] });
    return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
  };
  f.callbacks.release = async () => {
    closed = true;
    return { released: true };
  };
  await f.controller.ready(f.callbacks);
  const bashing = request(f, 'bash', {
    command: 'synthetic active bash',
  });
  await entered.promise;
  const releasing = request(f, 'release');
  await captureEntered.promise;
  assert.equal(stops, 1);
  assert.equal(closed, false);
  assert.equal((await readClaim(f.attachmentDir, f.session)).phase, 'transitioning');
  assert.equal(
    (await request(f, 'send', { text: 'fenced', mode: 'steer' })).error,
    'RUNTIME_SESSION_CHANGED',
  );
  captureFinish.resolve();
  assert.equal((await bashing).data.output, 'fixture');
  assert.equal((await releasing).data.released, true);
  assert.equal(closed, true);
  assert.equal(await readClaim(f.attachmentDir, f.session), null);
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

test('host names reach state consumers including an explicit clear', async (t) => {
  const f = await fixture(t),
    state = f.callbacks.state;
  let name = 'live host name';
  f.callbacks.state = () => ({ ...state(), sessionName: name });
  await f.controller.ready(f.callbacks);
  assert.equal((await request(f, 'state')).data.sessionName, name);
  name = null;
  assert.equal((await request(f, 'state')).data.sessionName, null);
});

test('invalid native control results fail without retry and later valid calls work', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.callbacks.bash = async () => {
    calls++;
    return { output: 42 };
  };
  f.callbacks.stop = async () => {
    calls++;
    return { acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
  };
  await f.controller.ready(f.callbacks);
  assert.equal((await request(f, 'bash', { command: 'fixture' })).error, 'INVALID_BASH_RESULT');
  assert.equal((await request(f, 'stop')).error, 'INVALID_STOP_RECEIPT');
  assert.equal(calls, 2, 'Invalid results do not retry native control');

  f.callbacks.bash = async () => ({
    output: 'inline only',
    exitCode: 0,
    cancelled: false,
    truncated: false,
  });
  assert.equal((await request(f, 'bash', { command: 'fixture' })).data.output, 'inline only');
});
