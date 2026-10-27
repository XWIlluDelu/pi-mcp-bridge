import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import packageInfo from '../package.json' with { type: 'json' };
import { AttachedRuntime, claimFile, processIdentity } from '../src/attachments.mjs';

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
      bridgeVersion: packageInfo.version,
    },
    requests = [],
    connections = new Set();
  let respond = () => ({ data: { sealed: true } });
  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      requests.push(request);
      const result = respond(request);
      if (result === null) return socket.destroy();
      socket.end(
        JSON.stringify({
          generation: record.generation,
          version: packageInfo.version,
          file: session.file,
          sessionId: session.header.id,
          ...result,
        }) + '\n',
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(record.socket, resolve);
  });
  await fs.chmod(record.socket, 0o600);
  await fs.writeFile(claimFile(dir, session), JSON.stringify(record), { mode: 0o600 });
  t.after(async () => {
    for (const socket of connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    runtime: new AttachedRuntime({ attachmentDir: dir }, session, record),
    requests,
    respond(fn) {
      respond = fn;
    },
  };
}

test('owned seal uses the current version and accepts only definite sealed or busy outcomes', async (t) => {
  const f = await fixture(t);
  let dispatched = 0;
  assert.deepEqual(await f.runtime.seal(() => dispatched++), { sealed: true });
  assert.equal(dispatched, 1);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0], {
    op: 'seal',
    body: {},
    version: packageInfo.version,
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
    [{ data: null }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true, reason: 'busy' } }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: false } }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true }, extra: true }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true }, error: 'INVALID_ARGUMENTS' }, 'INVALID_ATTACHMENT_RESPONSE'],
    [{ data: { sealed: true }, version: 'unsupported' }, 'OWNER_COMPONENT_UPDATE_REQUIRED'],
    [{ data: { sealed: true }, generation: 'another' }, 'RUNTIME_SESSION_CHANGED'],
    [{ data: { sealed: true }, sessionId: 'another' }, 'RUNTIME_SESSION_CHANGED'],
    [{ data: { sealed: true }, file: '/another/session.jsonl' }, 'RUNTIME_SESSION_CHANGED'],
    [{ error: 'OWNER_COMPONENT_UPDATE_REQUIRED', sessionId: 'another' }, 'RUNTIME_SESSION_CHANGED'],
    [
      { error: 'OWNER_COMPONENT_UPDATE_REQUIRED', file: '/another/session.jsonl' },
      'RUNTIME_SESSION_CHANGED',
    ],
    [{ error: 'ATTACHED_OPERATION_FAILED' }, 'ATTACHED_OPERATION_FAILED'],
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
  for (const replacement of [{ kind: 'host' }, { bridgeVersion: 'unsupported' }]) {
    const runtime = new AttachedRuntime(f.runtime.config, f.runtime.session, {
      ...f.runtime.record,
      ...replacement,
    });
    await assert.rejects(runtime.seal(), {
      code: 'OWNER_COMPONENT_UPDATE_REQUIRED',
      uncertain: false,
    });
    assert.equal(f.requests.length, 0);
  }
});
