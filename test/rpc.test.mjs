import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RpcFailure } from '../src/runtime/rpc.mjs';
import { RuntimePool } from '../src/runtime/runtime-pool.mjs';

const session = { file: '/isolated/session.jsonl', header: { id: 'native' } };
const identity = { sessionFile: session.file, sessionId: session.header.id };
const other = { ...identity, sessionId: 'other' };
const started = { disposition: 'started' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fixture(state = () => identity) {
  const rpc = new PiRpc({}, session);
  const writes = [],
    child = new EventEmitter();
  const emit = (event, generation = rpc.generation) => rpc.receiveResponse(event, generation);
  const ack = (command, data, extra) =>
    emit({
      type: 'response',
      id: command.id,
      command: command.type,
      success: true,
      data,
      ...extra,
    });
  rpc.alive = true;
  rpc.child = child;
  rpc.assertProcessIdentity = async () => {};
  child.stdin = {
    write(line) {
      const command = JSON.parse(line);
      writes.push(command);
      if (command.type === 'get_state') queueMicrotask(() => ack(command, state()));
    },
  };
  return { rpc, writes, child, emit, ack };
}

test('RPC identity checks fence dispatch and reject a reply under a changed identity', async () => {
  const { rpc, child } = fixture();
  child.stdin.write = () => {};
  await assert.rejects(rpc.state(1), { code: 'ACK_TIMEOUT', uncertain: false });
  for (const type of ['get_entries', 'prompt']) {
    for (const when of ['before', 'after']) {
      let observed = 0;
      const { rpc, writes, ack } = fixture(() =>
        when === 'before' || ++observed > 1 ? other : identity,
      );
      const pending = rpc.command({ type });
      if (when === 'after') {
        await tick();
        ack(writes.at(-1), type === 'prompt' ? started : { entries: ['private'] });
      }
      await assert.rejects(pending, {
        code: 'RUNTIME_SESSION_CHANGED',
        uncertain: when === 'after' && type === 'prompt',
      });
      assert.equal(
        writes.some((entry) => entry.type === type),
        when === 'after',
      );
    }
  }
});

test('shutdown preparation reports failed SIGTERM and explicit stop can retry without a stale promise', async () => {
  const { rpc, child } = fixture(),
    signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    throw Object.assign(new Error('test signal denied'), { code: 'EPERM' });
  };
  await assert.rejects(rpc.stop(), { code: 'EPERM' });
  assert.equal(child.listenerCount('exit'), 1);
  child.kill = () => false;
  const pool = new RuntimePool({ attachmentDir: '/unused-test-registry' });
  pool.instances.set('synthetic', rpc);
  rpc.gracefulExitPromise = Promise.resolve();
  await assert.rejects(pool.prepareClose(), { code: 'RUNTIME_STOP_FAILED' });
  assert.equal(child.listenerCount('exit'), 1);
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  await rpc.stop();
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  assert.equal(rpc.exited, true);
});

test('settlement, idle and bad ACKs leave timed-out admission fenced until the exact ACK', async () => {
  const { rpc, writes, emit, ack } = fixture();
  let late;
  await assert.rejects(
    rpc.dispatch(
      { type: 'prompt' },
      {
        timeout: 1,
        onLate: (value) => {
          late = value;
        },
      },
    ),
    {
      code: 'ACK_TIMEOUT',
      uncertain: true,
    },
  );
  const [first] = writes;
  await rpc.state();
  emit({ type: 'agent_start' });
  emit({ type: 'agent_settled', aborted: false }, 'retired');
  emit({ type: 'agent_settled' });
  assert.equal(rpc.settlementSequence, 0);
  emit({ type: 'agent_settled', aborted: false });
  assert.equal(rpc.settlementSequence, 1);
  ack(first, {});
  ack(first, started, { command: 'get_state' });
  emit(
    { type: 'response', id: first.id, command: 'prompt', success: true, data: started },
    'retired',
  );
  await assert.rejects(rpc.dispatch({ type: 'prompt' }), {
    code: 'PROMPT_ADMISSION_PENDING',
    uncertain: false,
  });
  assert.equal(writes.filter((x) => x.type === 'prompt').length, 1);
  ack(first, started);
  assert.deepEqual(late.data, started);

  const next = rpc.dispatch({ type: 'prompt' }),
    pending = writes.at(-1);
  ack(first, started);
  assert.ok(rpc.pending.has(pending.id));
  ack(pending, { disposition: 'queued' });
  assert.equal((await next).disposition, 'queued');
});
test('write uncertainty retains admission; authoritative rejection or confirmed exit releases it', async () => {
  for (const failure of ['callback', 'throw']) {
    const { rpc, child, writes, ack } = fixture();
    child.stdin.write = (line, cb) => {
      writes.push(JSON.parse(line));
      if (failure === 'throw') throw new Error('synthetic');
      cb(new Error('synthetic'));
    };
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'first' }, { timeout: 1000 }), {
      code: 'WRITE_UNKNOWN',
      uncertain: true,
    });
    assert.ok(rpc.hasPendingCommand('prompt'));
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'second' }), {
      code: 'PROMPT_ADMISSION_PENDING',
    });
    if (failure === 'callback') {
      ack(writes[0], undefined, { success: false });
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
    const { rpc, child } = fixture();
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

test('shutdown drains received ACK tasks without waiting for missing replies', async () => {
  const entered = Promise.withResolvers(),
    validate = Promise.withResolvers();
  const { rpc, child, writes, ack } = fixture();
  const pool = new RuntimePool({ attachmentDir: '/unused-test-registry' });
  pool.instances.set('isolated', rpc);
  let killed = false,
    receipt = false;
  child.kill = () => {
    assert.equal(receipt, true);
    killed = true;
    queueMicrotask(() => child.emit('exit', 0));
  };
  await assert.rejects(
    rpc.command(
      { type: 'prompt' },
      {
        timeout: 1,
        onLate: async () => {
          entered.resolve();
          await validate.promise;
          receipt = true;
        },
      },
    ),
    { code: 'ACK_TIMEOUT' },
  );
  await rpc.drainAcks();
  ack(
    writes.find((x) => x.type === 'prompt'),
    started,
  );
  await entered.promise;
  const stopping = pool.close();
  await tick();
  assert.equal(killed, false);
  validate.resolve();
  await stopping;
  assert.equal(killed, true);
});

test('late mutation replies recheck native identity even without an observer', async () => {
  for (const [type, data] of [
    ['prompt', started],
    ['set_model', { provider: 'fixture', id: 'model' }],
  ]) {
    let state = identity,
      published = false;
    const { rpc, writes, ack } = fixture(() => state);
    const onLate =
      type === 'prompt'
        ? () => {
            published = true;
          }
        : undefined;
    await assert.rejects(rpc.command({ type }, { timeout: 1, onLate }), { code: 'ACK_TIMEOUT' });
    state = other;
    ack(
      writes.find((command) => command.type === type),
      data,
    );
    await rpc.drainAcks();
    assert.equal(published, false);
    assert.deepEqual(
      writes.map((command) => command.type),
      ['get_state', type, 'get_state'],
    );
  }
});

test('owned Stop validates identity before cancelling and ignores wrong-method ACKs', async () => {
  const { rpc, writes, ack } = fixture(() => other);
  rpc.stop = () => assert.fail('Stop must retain the native writer');
  await assert.rejects(rpc.stopExecution(), { code: 'RUNTIME_SESSION_CHANGED', uncertain: false });
  assert.deepEqual(
    writes.map((c) => c.type),
    ['get_state'],
  );
  const aborted = rpc.dispatch({ type: 'abort' }),
    command = writes.at(-1);
  ack(command, null, { command: 'prompt' });
  assert.ok(rpc.pending.has(command.id));
  ack(command, null);
  await aborted;
});

test('late clear_queue ACK validates identity without cancellation replay, storage or result lookup', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let late,
    cancellations = 0,
    checks = 0,
    changed = false;
  rpc.dispatch = async (command, { onLate } = {}) => {
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
