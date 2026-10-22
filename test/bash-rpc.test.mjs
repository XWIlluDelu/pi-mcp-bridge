import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc, RpcFailure } from '../src/rpc.mjs';

test('native bash returns an inline bounded prefix and never publishes a late-result receipt', async () => {
  const session = { file: '/synthetic/session.jsonl', header: { id: 'native' } },
    rpc = new PiRpc({}, session);
  let late,
    executions = 0,
    checks = 0,
    delayed = false;
  rpc.dispatch = async (input, _timeout, onLate) => {
    if (input.type === 'get_state') {
      checks++;
      return { sessionFile: session.file, sessionId: session.header.id };
    }
    assert.equal(input.type, 'bash');
    executions++;
    if (delayed) {
      late = onLate;
      throw new RpcFailure('ACK_TIMEOUT', true);
    }
    return {
      output: 'Unicode 😀 quotes " slash \\ newline\n'.repeat(500),
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
  };
  const result = await rpc.executeBash({ command: 'synthetic', max_chars: 256 });
  assert.equal(result.output_complete, false);
  assert.ok(result.output.length > 0);
  delayed = true;
  await assert.rejects(rpc.executeBash({ command: 'synthetic', timeout_ms: 50 }), (error) => {
    assert.equal(error.uncertain, true);
    assert.equal(error.result, undefined);
    return true;
  });
  const before = checks;
  await late({
    ok: true,
    data: { output: 'only a late ACK', exitCode: 0, cancelled: false, truncated: false },
  });
  assert.equal(checks, before + 1);
  assert.equal(executions, 2, 'Late ACK does not replay native execution');
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
