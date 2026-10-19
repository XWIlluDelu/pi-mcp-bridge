import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RuntimePool } from '../src/rpc.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { Journal } from '../src/journal.mjs';
import { recoveredBash } from '../src/bash-execution.mjs';
import { hash } from '../src/storage.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
test('received late ACK recovery drains identity, result persistence and receipt before native termination', async () => {
  const rpc = new PiRpc({}, { file: '/isolated/session.jsonl', header: { id: 'isolated' } });
  const child = new EventEmitter(),
    writes = [];
  rpc.child = child;
  rpc.alive = true;
  child.stdin = {
    write: (line) => {
      const command = JSON.parse(line);
      writes.push(command);
      if (command.type === 'get_state')
        queueMicrotask(() =>
          rpc.receiveResponse(
            {
              type: 'response',
              id: command.id,
              success: true,
              data: { sessionFile: rpc.session.file, sessionId: 'isolated' },
            },
            rpc.generation,
          ),
        );
    },
  };
  let killed = false,
    persisted = false,
    receipt = false;
  child.kill = () => {
    killed = true;
    assert.equal(persisted, true);
    assert.equal(receipt, true);
    queueMicrotask(() => child.emit('exit', 0));
  };
  const entered = Promise.withResolvers(),
    disk = Promise.withResolvers();
  await assert.rejects(
    rpc.command({ type: 'prompt', message: 'offline' }, 1, async () => {
      entered.resolve();
      await disk.promise;
      persisted = true;
      await tick();
      receipt = true;
    }),
    { code: 'ACK_TIMEOUT' },
  );
  const command = writes.find((x) => x.type === 'prompt');
  rpc.receiveResponse(
    {
      type: 'response',
      id: command.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    },
    rpc.generation,
  );
  await entered.promise;
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.recoveryTasks.size, 1);
  const stopping = rpc.stop();
  await tick();
  assert.equal(killed, false);
  disk.resolve();
  await stopping;
  assert.equal(killed, true);
  assert.equal(rpc.recoveryTasks.size, 0);
});

test('pool drain includes received recovery but does not wait for ACKs not received', async () => {
  const rpc = new PiRpc({}, {});
  rpc.alive = true;
  rpc.child = { stdin: { write: () => {} } };
  await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'held' }, 1), {
    code: 'ACK_TIMEOUT',
  });
  const pool = new RuntimePool({});
  pool.instances.set('isolated', rpc);
  await pool.drainRecovery();
  assert.equal(rpc.pending.size, 1);
  const finish = Promise.withResolvers();
  let drained = false;
  rpc.trackRecovery(() => finish.promise);
  const draining = pool.drainRecovery().then(() => {
    drained = true;
  });
  await tick();
  assert.equal(drained, false);
  finish.resolve();
  await draining;
});

test('late ACK identity mismatch preserves unknown without circular shutdown or callback', async () => {
  const rpc = new PiRpc({}, { file: '/isolated/a', header: { id: 'a' } }),
    writes = [];
  rpc.alive = true;
  rpc.child = {
    stdin: {
      write: (line) => {
        const command = JSON.parse(line);
        writes.push(command);
        if (command.type === 'get_state')
          queueMicrotask(() =>
            rpc.receiveResponse(
              {
                type: 'response',
                id: command.id,
                success: true,
                data: {
                  sessionFile: writes.some((x) => x.type === 'prompt')
                    ? '/isolated/b'
                    : '/isolated/a',
                  sessionId: 'a',
                },
              },
              rpc.generation,
            ),
          );
      },
    },
  };
  let recovered = false;
  await assert.rejects(
    rpc.command({ type: 'prompt', message: 'fixture' }, 1, () => {
      recovered = true;
    }),
    { code: 'ACK_TIMEOUT' },
  );
  const command = writes.find((x) => x.type === 'prompt');
  rpc.receiveResponse(
    {
      type: 'response',
      id: command.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    },
    rpc.generation,
  );
  await rpc.drainRecovery();
  assert.equal(recovered, false);
  assert.equal(rpc.recoveryTasks.size, 0);
  assert.equal(rpc.recoveryError(), null);
});

test('only persistence recovery failures remain sticky after draining without interrupting cleanup', async () => {
  const rpc = new PiRpc({}, {});
  for (const code of ['RUNTIME_SESSION_CHANGED', 'ACK_TIMEOUT', 'PI_REJECTED'])
    rpc.trackRecovery(() => {
      throw Object.assign(new Error(code), { code });
    });
  await rpc.drainRecovery();
  assert.equal(rpc.recoveryError(), null);
  const errors = ['EIO', 'ENOSPC', 'EACCES', 'EROFS', 'EDQUOT'].map((code) =>
    Object.assign(new Error('storage'), { code }),
  );
  errors.push(
    new Error('RECEIPT_PERSIST_FAILED', { cause: new Error('underlying write failure') }),
  );
  errors.push(
    new Error('wrapper', { cause: Object.assign(new Error('disk full'), { code: 'ENOSPC' }) }),
  );
  for (const error of errors)
    rpc.trackRecovery(() => {
      throw error;
    });
  await rpc.drainRecovery();
  assert.equal(rpc.recoveryFailures.size, errors.length);
  const failure = rpc.recoveryError();
  assert.equal(failure.code, 'RECOVERY_PERSIST_FAILED');
  assert.equal(failure.uncertain, true);
  assert.deepEqual(failure.errors, errors);
  rpc.trackRecovery(() => Promise.resolve());
  await rpc.drainRecovery();
  assert.equal(rpc.recoveryFailures.size, errors.length);
});

test(
  'late native result storage failure survives pool removal while stop still closes the child',
  { timeout: 10000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-native-storage-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const file = path.join(dir, 'session.jsonl'),
      header = { type: 'session', version: 3, id: 'native-storage', cwd };
    await fs.writeFile(file, JSON.stringify(header) + '\n');
    const session = { id: 'native-storage', file, header, cwd },
      pool = new RuntimePool({ ...isolatedRuntime(dir), attachmentDir: path.join(dir, 'ipc') });
    t.after(async () => {
      await pool.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const rpc = await pool.resolve(session),
      receive = rpc.receiveResponse.bind(rpc);
    let held;
    t.mock.method(rpc, 'receiveResponse', (event, generation) => {
      if (event.type === 'response' && event.command === 'bash') {
        held = { event, generation };
        return;
      }
      receive(event, generation);
    });
    const put = Journal.prototype.put,
      storageError = Object.assign(new Error('synthetic full disk'), { code: 'ENOSPC' });
    t.mock.method(Journal.prototype, 'put', async function (...args) {
      if (this.config.principal === 'native-bash-results') throw storageError;
      return put.apply(this, args);
    });
    let recovered = false;
    await assert.rejects(
      rpc.executeBash({
        command: "printf 'NATIVE_STORAGE_FAILURE'",
        recovery_id: 'd'.repeat(64),
        timeout_ms: 1,
        onLate: () => {
          recovered = true;
        },
      }),
      { code: 'ACK_TIMEOUT' },
    );
    const deadline = Date.now() + 5000;
    while (!held && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(held);
    receive(held.event, held.generation);
    await pool.stop(session.id);
    assert.equal(rpc.exited, true);
    assert.equal(pool.instances.size, 0);
    assert.equal(recovered, false);
    assert.equal(rpc.recoveryError().code, 'RECOVERY_PERSIST_FAILED');
    const failure = pool.recoveryError();
    assert.equal(failure.code, 'RECOVERY_PERSIST_FAILED');
    assert.equal(failure.uncertain, true);
    assert.deepEqual(failure.errors, [storageError]);
    await pool.close();
    assert.deepEqual(pool.recoveryError().errors, [storageError]);
  },
);

test(
  'Bridge close waits for late native bash disk capture and final receipt before closing its Pi',
  { timeout: 15000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-native-recovery-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const config = {
      ...isolatedRuntime(dir),
      principal: 'native-recovery',
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      attachmentDir: path.join(dir, 'ipc'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ id: 'p', path: cwd }],
      grants: [{ folder: cwd, command: true }],
    };
    const bridge = await new Bridge(config).init(),
      made = await savedSession(bridge, { folder_id: 'p' }),
      session = await bridge.session(made.session_id);
    const rpc = await bridge.pool.resolve(session),
      receive = rpc.receiveResponse.bind(rpc);
    let held;
    t.mock.method(rpc, 'receiveResponse', (event, generation) => {
      if (event.type === 'response' && event.command === 'bash') {
        held = { event, generation };
        return;
      }
      receive(event, generation);
    });
    const finish = Promise.withResolvers(),
      entered = Promise.withResolvers(),
      put = Journal.prototype.put;
    t.mock.method(Journal.prototype, 'put', async function (...args) {
      if (this.config.principal === 'native-bash-results') {
        entered.resolve();
        await finish.promise;
      }
      return put.apply(this, args);
    });
    t.after(async () => {
      finish.resolve();
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const args = {
      session_id: session.id,
      request_id: 'native-late-result',
      command: "printf 'RECOVERED_NATIVE_OUTPUT'",
      timeout_ms: 50,
    };
    const initial = await bridge.command(args);
    assert.equal(initial.status, 'unknown');
    assert.equal(initial.reason, 'ACK_TIMEOUT');
    const deadline = Date.now() + 5000;
    while (!held && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(held);
    receive(held.event, held.generation);
    await entered.promise;
    assert.equal(rpc.pending.size, 0);
    let closed = false;
    const closing = bridge.close().then(() => {
      closed = true;
    });
    await tick();
    assert.equal(closed, false);
    assert.equal(rpc.exited, false);
    finish.resolve();
    await closing;
    assert.equal(rpc.exited, true);
    const id = hash({ principal: config.principal, session: session.id, request: args.request_id });
    const result = await recoveredBash(config.attachmentDir, session, rpc.generation, id);
    assert.equal(result.output, 'RECOVERED_NATIVE_OUTPUT');
    assert.equal((await new Journal(config).get(args.request_id)).receipt.status, 'accepted');
  },
);
