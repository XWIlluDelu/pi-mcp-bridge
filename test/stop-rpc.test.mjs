import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc, RpcFailure } from '../src/rpc.mjs';

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
