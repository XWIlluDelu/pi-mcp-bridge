import {
  attachmentServer,
  listenPrivate,
  ownerEnvelope,
  MAX_ATTACHMENT_REQUEST_BYTES,
} from '../src/runtime/attachment-protocol.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

import { AttachedRuntime, claimFile, processIdentity } from '../src/runtime/attachments.mjs';
import { PiRpc } from '../src/runtime/rpc.mjs';
import { until } from './fixtures/until.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-seal-'),
    session = { file: path.join(dir, 'session.jsonl'), header: { id: 'seal-fixture' } },
    record = {
      kind: 'rpc',
      generation: 'seal-generation',
      file: session.file,
      sessionId: session.header.id,
      phase: 'ready',
      owner: await processIdentity(),
      socket: path.join(dir, 'observer.sock'),
      bridgeVersion: '0.8.0-dev.17',
    },
    requests = [],
    connections = new Set();
  let respond = () => ({ data: { sealed: true } });
  const server = attachmentServer(connections, async (frame, socket) => {
    const request = JSON.parse(frame);
    requests.push(request);
    const result = await respond(request, socket);
    if (result === null) socket.destroy();
    else if (result !== undefined) socket.end(ownerEnvelope(record, result));
  });
  await listenPrivate(server, record.socket);
  await fs.writeFile(claimFile(dir, session), JSON.stringify(record), { mode: 0o600 });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    connections,
    runtime: new AttachedRuntime({ attachmentDir: dir }, session, record),
    requests,
    respond(fn) {
      respond = fn;
    },
  };
}

test('owned seal addresses the live endpoint and accepts definite sealed or busy outcomes', async (t) => {
  const f = await fixture(t);
  let dispatched = 0;
  assert.deepEqual(await f.runtime.seal(() => dispatched++), { sealed: true });
  assert.equal(dispatched, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], {
    op: 'seal',
    body: {},
    version: f.runtime.record.bridgeVersion,
    generation: f.runtime.record.generation,
    file: f.runtime.session.file,
    sessionId: f.runtime.session.header.id,
  });
  f.respond(() => ({ data: { sealed: false, reason: 'busy' } }));
  assert.deepEqual(await f.runtime.seal(), { sealed: false, reason: 'busy' });
  for (const error of [
    'OWNER_COMPONENT_UPDATE_REQUIRED',
    'RUNTIME_SESSION_CHANGED',
    'INVALID_ARGUMENTS',
  ]) {
    f.respond(() => ({ error }));
    await assert.rejects(f.runtime.seal(), { code: error, uncertain: false });
  }
});

test('written seal failures remain uncertain and are never replayed', async (t) => {
  const f = await fixture(t);
  for (const [response, code] of [
    [null, 'LIVE_OWNER_UNREACHABLE'],
    [{ data: { sealed: false } }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true }, error: 'INVALID_ARGUMENTS' }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true }, generation: 'another' }, 'RUNTIME_SESSION_CHANGED'],
    [{ error: 'OWNER_COMPONENT_UPDATE_REQUIRED', sessionId: 'another' }, 'RUNTIME_SESSION_CHANGED'],
  ]) {
    const before = f.requests.length;
    f.respond(() => response);
    await assert.rejects(f.runtime.seal(), { code, uncertain: true });
    assert.equal(f.requests.length, before + 1);
  }
});

test('seal rejects unsupported owners and cancellation before writing without sending a request', async (t) => {
  const f = await fixture(t),
    failure = new Error('cancelled before dispatch');
  await assert.rejects(
    f.runtime.seal(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(f.requests.length, 0);
  const runtime = new AttachedRuntime(f.runtime.config, f.runtime.session, {
    ...f.runtime.record,
    kind: 'host',
  });
  await assert.rejects(runtime.seal(), {
    code: 'OWNER_COMPONENT_UPDATE_REQUIRED',
    uncertain: false,
  });
  assert.equal(f.requests.length, 0);
});

test(
  'an owner disconnect settles before slow authorization can dispatch',
  { timeout: 2000 },
  async (t) => {
    const f = await fixture(t);
    const entered = Promise.withResolvers(),
      proceed = Promise.withResolvers();
    t.after(() => proceed.resolve());
    const pending = f.runtime.seal(() => {
      entered.resolve();
      return proceed.promise;
    });
    const rejected = assert.rejects(pending, { code: 'LIVE_OWNER_UNREACHABLE', uncertain: false });
    await entered.promise;
    await until(() => f.connections.size > 0);
    for (const connection of f.connections) connection.end();
    await rejected;
    proceed.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests.length, 0);
  },
);

test(
  'a complete owner reply resolves before the peer closes its write side',
  { timeout: 2000 },
  async (t) => {
    const f = await fixture(t);
    f.respond((_request, connection) => {
      connection.write(ownerEnvelope(f.runtime.record, { data: { sealed: true } }));
    });
    assert.deepEqual(await f.runtime.seal(), { sealed: true });
  },
);

test(
  'a partial owner reply preserves its evidence through the client deadline',
  { timeout: 3000 },
  async (t) => {
    const f = await fixture(t);
    const withdrawal = { text: 'queued', includesEditorDraft: false, complete: false };
    f.respond((_request, connection) => {
      connection.write(ownerEnvelope(f.runtime.record, { partial: true, data: { withdrawal } }));
    });
    await assert.rejects(f.runtime.request('stop', {}, { timeout: 1000 }), {
      code: 'ACK_TIMEOUT',
      uncertain: true,
      result: { withdrawal },
    });
  },
);

const ownedRpc = (f) => {
  const rpc = new PiRpc(f.runtime.config, f.runtime.session);
  rpc.ownerRecord = f.runtime.record;
  rpc.alive = true;
  return rpc;
};
const idleCompact = { type: 'compact', customInstructions: '', idleOnly: true };
const compacted = { firstKeptEntryId: 'kept', tokensBefore: 1000 };

function beforeWrite(t, gate) {
  const request = AttachedRuntime.prototype.request;
  t.mock.method(AttachedRuntime.prototype, 'request', function (op, body, options = {}) {
    return request.call(this, op, body, {
      ...options,
      beforeDispatch: async () => {
        await options.beforeDispatch?.();
        await gate();
      },
    });
  });
}

test('owner framing isolates fragmented, malformed, oversized and idle requests', async (t) => {
  const f = await fixture(t);
  const request = ownerEnvelope(f.runtime.record, { op: 'seal', body: {} });
  const setTimeout = net.Socket.prototype.setTimeout;
  t.mock.method(net.Socket.prototype, 'setTimeout', function (ms, callback) {
    return setTimeout.call(this, ms === 5000 ? 100 : ms, callback);
  });
  const raw = (send) =>
    new Promise((resolve, reject) => {
      const socket = net.createConnection(f.runtime.record.socket);
      let reply = '';
      socket.setEncoding('utf8');
      socket.on('error', (error) => {
        if (error.code !== 'ECONNRESET' && error.code !== 'EPIPE') reject(error);
      });
      socket.on('data', (chunk) => {
        reply += chunk;
      });
      socket.on('close', () => resolve(reply));
      socket.on('connect', () => send(socket));
    });
  const fragmented = await raw((socket) => {
    const [server] = f.connections;
    server.once('data', () => socket.end(request.slice(9)));
    socket.write(request.slice(0, 9));
  });
  assert.deepEqual(JSON.parse(fragmented).data, { sealed: true });
  for (const input of ['{\n', request.slice(0, -1), 'x'.repeat(MAX_ATTACHMENT_REQUEST_BYTES + 1)])
    assert.equal(await raw((socket) => socket.end(input)), '');
  assert.equal(await raw((socket) => socket.write(request.slice(0, 9))), '');
  assert.equal(f.requests.length, 1);
  assert.deepEqual(JSON.parse(await raw((socket) => socket.end(request.repeat(2)))).data, {
    sealed: true,
  });
  assert.equal(f.requests.length, 2);
  assert.deepEqual(await f.runtime.seal(), { sealed: true });
});

test(
  'owned compact cancels an expired pre-write request without later dispatch',
  { timeout: 5000 },
  async (t) => {
    const f = await fixture(t),
      rpc = ownedRpc(f);
    const entered = Promise.withResolvers(),
      resume = Promise.withResolvers();
    t.after(() => resume.resolve());
    beforeWrite(t, () => {
      entered.resolve();
      return resume.promise;
    });
    const pending = rpc.dispatch(idleCompact, { timeout: 1000 });
    const rejected = assert.rejects(pending, { code: 'ACK_TIMEOUT', uncertain: false });
    await entered.promise;
    await rejected;
    resume.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.requests.length, 0);
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.hasPendingCommand('compact'), false);
  },
);

test('owned compact keeps its control connection and fence for a matching late reply', async (t) => {
  const f = await fixture(t),
    rpc = ownedRpc(f);
  const response = Promise.withResolvers(),
    late = Promise.withResolvers();
  t.after(() => response.resolve({ data: compacted }));
  f.respond(() => response.promise);
  await assert.rejects(
    rpc.dispatch(idleCompact, { timeout: 100, onLate: (result) => late.resolve(result) }),
    {
      code: 'ACK_TIMEOUT',
      uncertain: true,
    },
  );
  assert.equal(f.requests.length, 1);
  assert.equal(rpc.pending.size, 1);
  assert.ok(rpc.hasPendingCommand('compact'));
  await rpc.drainAcks(); // Missing replies are not received ACK tasks.
  response.resolve({ data: compacted });
  assert.deepEqual(await late.promise, { ok: true, data: compacted });
  await rpc.drainAcks();
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.hasPendingCommand('compact'), false);
  assert.equal(f.requests.length, 1);
});

test('owned compact rechecks Stop synchronously at the socket write boundary', async (t) => {
  const f = await fixture(t),
    rpc = ownedRpc(f);
  let stopped = false;
  beforeWrite(t, () => {
    queueMicrotask(() => {
      stopped = true;
    });
  });
  await assert.rejects(
    rpc.dispatch(idleCompact, {
      beforeDispatch: () => {
        if (stopped) throw new Error('STOP_IN_PROGRESS');
      },
    }),
    { code: 'STOP_IN_PROGRESS', uncertain: false },
  );
  assert.equal(stopped, true);
  assert.equal(f.requests.length, 0);
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.hasPendingCommand('compact'), false);
});

test('owned compact validates reply identity and metadata before releasing its fence', async (t) => {
  const f = await fixture(t);
  for (const result of [
    { data: compacted, sessionId: 'another' },
    { data: compacted, generation: 'another' },
    { data: null },
    null,
  ]) {
    const rpc = ownedRpc(f);
    f.respond(() => result);
    await assert.rejects(rpc.dispatch(idleCompact), { uncertain: true });
    assert.equal(rpc.pending.size, 1);
    assert.ok(rpc.hasPendingCommand('compact'));
  }
  const rpc = ownedRpc(f);
  f.respond(() => ({ error: 'COMPACT_BUSY' }));
  await assert.rejects(rpc.dispatch(idleCompact), { code: 'COMPACT_BUSY', uncertain: false });
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.hasPendingCommand('compact'), false);
});
