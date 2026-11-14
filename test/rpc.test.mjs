import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RpcFailure, RuntimePool } from '../src/rpc.mjs';

test('mismatched Pi state refuses read/send without terminating or dispatching under the wrong identity', async () => {
  for (const command of [{ type: 'get_entries' }, { type: 'prompt', message: 'fixture' }]) {
    const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
    let stopped = false;
    const calls = [];
    rpc.stop = async () => {
      stopped = true;
    };
    rpc.dispatch = async (c) => {
      calls.push(c.type);
      return { sessionFile: '/sessions/b.jsonl', sessionId: 'b' };
    };
    await assert.rejects(rpc.command(command), { code: 'RUNTIME_SESSION_CHANGED' });
    assert.equal(stopped, false);
    assert.deepEqual(calls, ['get_state']);
  }
});

test('identity change during read suppresses content; during prompt preserves uncertainty', async () => {
  for (const type of ['get_entries', 'prompt']) {
    const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
    let states = 0;
    rpc.stop = async () => {};
    rpc.dispatch = async (c) =>
      c.type === 'get_state'
        ? ++states === 1
          ? { sessionFile: '/sessions/a.jsonl', sessionId: 'a' }
          : { sessionFile: '/sessions/b.jsonl', sessionId: 'b' }
        : { entries: ['private'], disposition: 'started' };
    await assert.rejects(
      rpc.command({ type }),
      (error) =>
        error.code === 'RUNTIME_SESSION_CHANGED' && error.uncertain === (type === 'prompt'),
    );
  }
});

test('shutdown preparation reports failed SIGTERM and explicit stop can retry without a stale promise', async () => {
  const rpc = new PiRpc({}, {}),
    child = new EventEmitter(),
    signals = [];
  rpc.child = child;
  rpc.assertProcessIdentity = async () => {}; // Synthetic child.
  rpc.alive = true;
  child.kill = (signal) => {
    signals.push(signal);
    throw Object.assign(new Error('test signal denied'), { code: 'EPERM' });
  };
  await assert.rejects(rpc.stop(), { code: 'EPERM' });
  assert.equal(child.listenerCount('exit'), 1); // One reusable lifetime exit observer.
  child.kill = () => false;
  const pool = new RuntimePool({ attachmentDir: '/unused-test-registry' });
  pool.instances.set('synthetic', rpc);
  rpc.gracefulExitPromise = Promise.resolve();
  await assert.rejects(pool.prepareClose(), { code: 'RUNTIME_STOP_FAILED' });
  assert.equal(child.listenerCount('exit'), 1); // One reusable lifetime exit observer.
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  await rpc.stop();
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  assert.equal(rpc.exited, true);
});

test('unresolved prompt admission survives timeout, idle, malformed and old-generation replies', async () => {
  const rpc = new PiRpc({}, {}),
    writes = [];
  rpc.alive = true;
  rpc.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) } };
  let late;
  await assert.rejects(
    rpc.dispatch({ type: 'prompt', message: 'first' }, 10, (result) => {
      late = result;
    }),
    { code: 'ACK_TIMEOUT', uncertain: true },
  );
  const first = writes[0],
    generation = rpc.generation;
  const state = rpc.dispatch({ type: 'get_state' }, 1000);
  const stateRequest = writes.at(-1);
  rpc.receiveResponse(
    { type: 'response', id: stateRequest.id, success: true, data: { isStreaming: false } },
    generation,
  );
  await state;
  for (const event of [
    { type: 'agent_settled', aborted: false },
    {
      type: 'response',
      id: first.id,
      command: 'get_state',
      success: true,
      data: { disposition: 'started' },
    },
    { type: 'response', id: first.id, command: 'prompt', success: true, data: {} },
  ])
    rpc.receiveResponse(event, generation);
  const ack = {
    type: 'response',
    id: first.id,
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  };
  rpc.receiveResponse(ack, 'old-generation');
  await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'second' }), {
    code: 'PROMPT_ADMISSION_PENDING',
    uncertain: false,
  });
  assert.equal(writes.filter((x) => x.type === 'prompt').length, 1);
  rpc.receiveResponse(ack, generation);
  assert.equal(late.data.disposition, 'started');
  const next = rpc.dispatch({ type: 'prompt', message: 'next', streamingBehavior: 'steer' }, 1000),
    nextRequest = writes.at(-1);
  rpc.receiveResponse(ack, generation);
  assert.equal(
    [...rpc.pending.keys()].find((id) => rpc.pending.get(id).commandType === 'prompt'),
    nextRequest.id,
  );
  rpc.receiveResponse(
    {
      type: 'response',
      id: nextRequest.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'queued' },
    },
    generation,
  );
  assert.equal((await next).disposition, 'queued');
});
test('write uncertainty retains admission; authoritative rejection or confirmed exit releases it', async () => {
  for (const failure of ['callback', 'throw']) {
    const rpc = new PiRpc({}, {});
    rpc.assertProcessIdentity = async () => {}; // Synthetic child.
    rpc.alive = true;
    let written;
    const child = new EventEmitter();
    child.stdin = {
      write: (line, cb) => {
        written = JSON.parse(line);
        if (failure === 'throw') throw new Error('synthetic');
        cb(new Error('synthetic'));
      },
    };
    rpc.child = child;
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'first' }, 1000), {
      code: 'WRITE_UNKNOWN',
      uncertain: true,
    });
    assert.ok(rpc.hasPendingCommand('prompt'));
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'second' }), {
      code: 'PROMPT_ADMISSION_PENDING',
    });
    if (failure === 'callback') {
      rpc.receiveResponse(
        { type: 'response', id: written.id, command: 'prompt', success: false },
        rpc.generation,
      );
      assert.equal(rpc.hasPendingCommand('prompt'), false);
    } else {
      child.kill = () => {
        assert.ok(rpc.hasPendingCommand('prompt'));
        setImmediate(() => child.emit('exit', 0));
      };
      await rpc.stop();
      assert.equal(rpc.hasPendingCommand('prompt'), false);
      assert.equal(rpc.exited, true);
    }
  }
});

test('post-ACK identity failures preserve already observed UI facts and uncertainty', async () => {
  const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
  let states = 0;
  const ui = { cancel_sent: ['confirm'], completion: 'unconfirmed' };
  rpc.dispatch = async (command) => {
    if (command.type === 'get_state') {
      if (++states === 1) return { sessionFile: rpc.session.file, sessionId: 'a' };
      throw new RpcFailure('RUNTIME_DISCONNECTED');
    }
    return { disposition: 'handled', ui };
  };
  await assert.rejects(rpc.command({ type: 'prompt', message: 'x' }), (error) => {
    assert.equal(error.uncertain, true);
    assert.deepEqual(error.ui, ui);
    return true;
  });
});

test('stop tolerates exact natural exit during identity validation, but never signals a live mismatched process', async () => {
  for (const exited of [true, false]) {
    const rpc = new PiRpc({}, {}),
      child = new EventEmitter();
    rpc.child = child;
    rpc.alive = true;
    let signals = 0;
    child.kill = () => {
      signals++;
      return true;
    };
    rpc.assertProcessIdentity = async () => {
      if (exited) child.emit('exit', 0, null);
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    };
    if (exited) await rpc.stop();
    else await assert.rejects(rpc.stop(), /RUNTIME_SESSION_CHANGED/);
    assert.equal(signals, 0);
    assert.equal(rpc.exited, exited);
  }
});

test('settlement advances only for the current generation and preserves pending admission', () => {
  const rpc = new PiRpc({}, {});
  rpc.receiveResponse({ type: 'agent_start' }, rpc.generation);
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, 'retired-generation');
  rpc.receiveResponse({ type: 'agent_settled' }, rpc.generation);
  assert.equal(rpc.settlementSequence, 0);
  assert.equal(rpc.hasUnsettledWork(), true);
  rpc.pending.set('unresolved', { commandType: 'prompt' });
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, rpc.generation);
  assert.equal(rpc.settlementSequence, 1);
  assert.equal(rpc.hasUnsettledWork(), true);
  rpc.pending.delete('unresolved');
  assert.equal(rpc.hasUnsettledWork(), false);
  rpc.receiveResponse({ type: 'agent_start' }, rpc.generation);
  rpc.receiveResponse({ type: 'agent_settled', aborted: true }, rpc.generation);
  assert.equal(rpc.settlementSequence, 2);
  assert.equal(rpc.hasUnsettledWork(), false);
  const replacement = new PiRpc({}, {});
  assert.notEqual(replacement.generation, rpc.generation);
  assert.equal(replacement.settlementSequence, 0);
});

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
  const pool = new RuntimePool({ attachmentDir: '/unused-test-registry' });
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

test('owned cancellation validates identity without terminating, and ignores wrong-method ACKs', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let calls = 0;
  rpc.stop = () => assert.fail('Cancellation must not terminate Pi');
  rpc.dispatch = async () => {
    calls++;
    return { sessionFile: session.file, sessionId: 'different' };
  };
  await assert.rejects(
    rpc.stopExecution(),
    (error) => error.code === 'RUNTIME_SESSION_CHANGED' && !error.uncertain,
  );
  assert.equal(calls, 1);
  const done = Promise.withResolvers(),
    id = 'synthetic-abort';
  rpc.pending.set(id, {
    commandType: 'abort',
    generation: rpc.generation,
    resolve: done.resolve,
    reject: done.reject,
    written: true,
  });
  rpc.receiveResponse({ type: 'response', id, command: 'prompt', success: true }, rpc.generation);
  assert.equal(rpc.pending.size, 1);
  rpc.receiveResponse({ type: 'response', id, command: 'abort', success: true }, rpc.generation);
  await done.promise;
  assert.equal(rpc.pending.size, 0);
});

test('late clear_queue ACK validates identity without cancellation replay, storage or result lookup', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let late,
    cancellations = 0,
    checks = 0,
    changed = false;
  rpc.dispatch = async (command, _timeout, onLate) => {
    if (command.type === 'get_state') {
      checks++;
      return { sessionFile: session.file, sessionId: changed ? 'different' : session.header.id };
    }
    if (command.type === 'clear_queue') {
      late = onLate;
      throw new RpcFailure('ACK_TIMEOUT', true);
    }
    cancellations++;
  };
  await assert.rejects(
    rpc.stopExecution(),
    (error) => error.code === 'ACK_TIMEOUT' && error.uncertain && !error.result,
  );
  await late({ ok: true, data: { steering: ['late text'], followUp: [] } });
  assert.equal(checks, 2);
  assert.equal(cancellations, 2);
  changed = true;
  await assert.rejects(
    late({ ok: true, data: { steering: [], followUp: [] } }),
    /RUNTIME_SESSION_CHANGED/,
  );
  assert.equal(cancellations, 2);
});

test('known withdrawal precedes uncertain cancellation and remains bounded inside the original result', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  rpc.dispatch = async (command) => {
    if (command.type === 'get_state')
      return { sessionFile: session.file, sessionId: session.header.id };
    if (command.type === 'clear_queue')
      return { steering: ['keep 😀 '.repeat(1000)], followUp: ['tail'] };
    if (command.type === 'abort') throw new RpcFailure('ACK_TIMEOUT', true);
  };
  await assert.rejects(rpc.stopExecution({ max_chars: 256 }), (error) => {
    assert.equal(error.uncertain, true);
    assert.equal(error.result.withdrawal.complete, false);
    assert.ok(('keep 😀 '.repeat(1000) + '\n\ntail').startsWith(error.result.withdrawal.text));
    return true;
  });
});

test('post-dispatch identity changes reject known native output rather than attach it to another session', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let dispatched = false;
  rpc.dispatch = async (input) => {
    if (input.type === 'get_state')
      return { sessionFile: session.file, sessionId: dispatched ? 'different' : session.header.id };
    dispatched = true;
    return { output: 'untrusted session output', exitCode: 0, cancelled: false, truncated: false };
  };
  await assert.rejects(
    rpc.executeBash({ command: 'synthetic' }),
    (error) => error.code === 'RUNTIME_SESSION_CHANGED' && error.uncertain,
  );
});
