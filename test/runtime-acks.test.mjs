import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RuntimePool } from '../src/rpc.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));
test('received late ACK validation drains before native termination', async () => {
  const rpc = new PiRpc({}, { file: '/isolated/session.jsonl', header: { id: 'isolated' } });
  const child = new EventEmitter(),
    writes = [];
  rpc.child = child;
  rpc.assertProcessIdentity = async () => {}; // Synthetic child.
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
    validated = false,
    receipt = false;
  child.kill = () => {
    killed = true;
    assert.equal(validated, true);
    assert.equal(receipt, true);
    queueMicrotask(() => child.emit('exit', 0));
  };
  const entered = Promise.withResolvers(),
    validation = Promise.withResolvers();
  await assert.rejects(
    rpc.command({ type: 'prompt', message: 'offline' }, 1, async () => {
      entered.resolve();
      await validation.promise;
      validated = true;
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
  assert.equal(rpc.ackTasks.size, 1);
  const stopping = rpc.stop();
  await tick();
  assert.equal(killed, false);
  validation.resolve();
  await stopping;
  assert.equal(killed, true);
  assert.equal(rpc.ackTasks.size, 0);
});

test('pool drain includes received ACK tasks but does not wait for missing ACKs', async () => {
  const rpc = new PiRpc({}, {});
  rpc.alive = true;
  rpc.child = { stdin: { write: () => {} } };
  await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'held' }, 1), {
    code: 'ACK_TIMEOUT',
  });
  const pool = new RuntimePool({});
  pool.instances.set('isolated', rpc);
  await pool.drainAcks();
  assert.equal(rpc.pending.size, 1);
  const finish = Promise.withResolvers();
  let drained = false;
  rpc.trackAck(() => finish.promise);
  const draining = pool.drainAcks().then(() => {
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
  await rpc.drainAcks();
  assert.equal(recovered, false);
  assert.equal(rpc.ackTasks.size, 0);
});
