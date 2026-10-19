import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PiRpc, RpcFailure } from '../src/rpc.mjs';
import { recoveredBash } from '../src/bash-execution.mjs';
test('owned bash rejects misbound native identity and preserves late native result without rerunning', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bash-rpc-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({ attachmentDir: dir }, session),
    id = 'a'.repeat(64);
  rpc.stop = () => assert.fail('command errors must not terminate Pi');
  let late,
    executions = 0,
    mismatched = false;
  const saved = Promise.withResolvers();
  rpc.dispatch = async (command, _timeout, onLate) => {
    if (command.type === 'get_state')
      return { sessionFile: session.file, sessionId: mismatched ? 'different' : session.header.id };
    assert.equal(command.type, 'bash');
    executions++;
    late = onLate;
    throw new RpcFailure('ACK_TIMEOUT', true);
  };
  await assert.rejects(
    rpc.executeBash({ command: 'fixture', recovery_id: id, onLate: () => saved.resolve() }),
    (error) => error.code === 'ACK_TIMEOUT' && error.uncertain,
  );
  late({
    ok: true,
    data: {
      output: 'native truncated tail',
      exitCode: undefined,
      cancelled: true,
      truncated: true,
      fullOutputPath: '/synthetic/output.txt',
    },
  });
  await saved.promise;
  const result = await recoveredBash(dir, session, rpc.generation, id);
  assert.equal(result.output, 'native truncated tail');
  assert.equal(result.exitCode, null);
  assert.equal(result.cancelled, true);
  assert.equal(result.truncated, true);
  assert.equal(result.fullOutputPath, '/synthetic/output.txt');
  assert.equal(executions, 1);
  await assert.rejects(recoveredBash(dir, session, 'other', id), /RUNTIME_SESSION_CHANGED/);
  mismatched = true;
  await assert.rejects(
    rpc.executeBash({ command: 'not dispatched', recovery_id: id }),
    (error) => error.code === 'RUNTIME_SESSION_CHANGED' && !error.uncertain,
  );
  assert.equal(executions, 1);
  const ack = Promise.withResolvers();
  rpc.pending.set('bash-ack', {
    commandType: 'bash',
    generation: rpc.generation,
    resolve: ack.resolve,
    reject: ack.reject,
    written: true,
  });
  rpc.receiveResponse(
    { type: 'response', id: 'bash-ack', command: 'abort_bash', success: true },
    rpc.generation,
  );
  assert.equal(rpc.pending.size, 1);
  rpc.receiveResponse(
    { type: 'response', id: 'bash-ack', command: 'bash', success: true, data: result },
    rpc.generation,
  );
  await ack.promise;
  assert.equal(rpc.pending.size, 0);
});

test('native dispatch fences are definite refusals, not uncertain bash execution', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bash-fence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({ attachmentDir: dir }, session);
  rpc.alive = true;
  rpc.child = { stdin: { write: () => assert.fail('fenced command must not be written') } };
  const dispatch = rpc.dispatch.bind(rpc);
  rpc.dispatch = (command, ...args) =>
    command.type === 'get_state'
      ? Promise.resolve({ sessionFile: session.file, sessionId: session.header.id })
      : dispatch(command, ...args);
  for (const code of ['HANDOFF_PENDING', 'RUNTIME_SHUTTING_DOWN']) {
    rpc.handoffPending = code === 'HANDOFF_PENDING';
    rpc.gracefulExitPromise = code === 'RUNTIME_SHUTTING_DOWN' ? Promise.resolve() : null;
    await assert.rejects(
      rpc.executeBash({ command: 'not dispatched', recovery_id: 'b'.repeat(64) }),
      (error) => error.code === code && !error.uncertain,
    );
  }
});
