import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { PiRpc, RpcFailure } from '../src/rpc.mjs';
import { recoveredWithdrawal } from '../src/stop-execution.mjs';

test('owned cancellation validates identity without terminating, and ignores wrong-method ACKs', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let calls = 0;
  rpc.stop = () => assert.fail('cancellation must not terminate Pi');
  rpc.dispatch = async () => {
    calls++;
    return { sessionFile: session.file, sessionId: 'different' };
  };
  await assert.rejects(
    rpc.stopExecution({ recovery_id: 'a'.repeat(64) }),
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

test('owned late clear_queue ACK preserves full recovery after timeout without another cancellation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stop-late-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({ attachmentDir: dir }, session);
  const id = 'b'.repeat(64);
  let late,
    cancellations = 0;
  rpc.dispatch = async (command, _timeout, onLate) => {
    if (command.type === 'get_state')
      return { sessionFile: session.file, sessionId: session.header.id };
    if (command.type === 'clear_queue') {
      late = onLate;
      throw new RpcFailure('ACK_TIMEOUT', true);
    }
    cancellations++;
  };
  await assert.rejects(
    rpc.stopExecution({ recovery_id: id }),
    (error) => error.code === 'ACK_TIMEOUT' && error.uncertain,
  );
  late({ ok: true, data: { steering: ['late complete 😀 text'], followUp: ['second'] } });
  let recovered;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    recovered = await recoveredWithdrawal(dir, session, rpc.generation, id);
    if (recovered) break;
    await delay(5);
  }
  assert.equal(recovered.text, 'late complete 😀 text\n\nsecond');
  assert.equal(cancellations, 2);
  // Native identity/generation binding is not weakened for private recovery.
  await assert.rejects(
    recoveredWithdrawal(dir, session, 'different', id),
    /RUNTIME_SESSION_CHANGED/,
  );
  await assert.rejects(
    recoveredWithdrawal(dir, { ...session, header: { id: 'other' } }, rpc.generation, id),
    /RUNTIME_SESSION_CHANGED/,
  );
});
