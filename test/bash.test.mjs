import { nativeOwner } from './fixtures/native-owner.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reserveHostSession } from '../src/host-adapter.mjs';

import { validateGrants } from '../src/owner-config.mjs';
import { dropPartialReply } from './fixtures/drop-partial-reply.mjs';
async function fixture(t) {
  const f = await nativeOwner(t, {
    prefix: 'bash-api',
    factory: () => assert.fail('No fallback writer'),
  });
  const { bridge, config, session: saved } = f,
    [rule] = config.grants;
  const controller = await reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: bridge.pool.attachmentDir,
    session: saved,
  });
  let calls = 0;
  const output = 'complete 😀 "\\ result\n'.repeat(1500);
  const callbacks = {
    state: async () => ({ sessionFile: saved.file, sessionId: saved.header.id }),
    snapshot: async () => ({ entries: [], leafId: null }),
    submit: async () => ({ status: 'unknown' }),
    stop: async ({ onWithdraw }) => {
      await onWithdraw({ steering: [], followUp: [] });
      return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
    },
    bash: async ({ beforeDispatch, onResult }) => {
      beforeDispatch();
      calls++;
      await onResult({ output, exitCode: 0, cancelled: false, truncated: false });
      return { output, exitCode: 0, cancelled: false, truncated: false };
    },
  };
  await controller.ready(callbacks);
  f.cleanup.push(() => controller.close());
  const call = (args) => callBridgeTool(bridge, 'command', { session_id: saved.id, ...args });
  return { ...f, rule, saved, call, calls: () => calls, callbacks, output };
}
test('MCP command permission is independent and output is bounded without continuation', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call({ command: 'must not run' })).isError, true);
  assert.equal(f.calls(), 0);
  validateGrants([
    { folder: f.saved.cwd, command: true },
    { session_id: f.saved.id, command: null },
  ]);
  assert.throws(() => validateGrants([{ folder: f.saved.cwd, command: 'enabled' }]));
  Object.assign(f.rule, { command: true, send: false, stop: false, read: false });
  const response = await f.call({ command: 'native command', max_chars: 512 });
  assert.ok(!response.isError);
  const result = response.structuredContent;
  assert.equal(result.exitCode, 0);
  assert.equal(result.native_truncated, false);
  assert.equal(result.response_complete, false);
  assert.ok(f.output.startsWith(result.output));
  assert.ok(JSON.stringify({ output: result.output }).length <= 512);
  assert.equal((await f.call({})).isError, true);
  assert.equal(f.calls(), 1);
  f.rule.command = false;
  assert.equal((await f.call({ command: 'denied' })).isError, true);
  assert.equal(f.calls(), 1);
  f.rule.command = true;
});

test('connection loss after received native bash output retains it without repeating execution', async (t) => {
  const f = await fixture(t),
    finish = Promise.withResolvers(),
    entered = Promise.withResolvers();
  f.rule.command = true;
  f.callbacks.bash = async ({ onResult }) => {
    entered.resolve();
    await onResult({
      output: 'result before lost ACK',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    });
    await finish.promise;
    return { output: 'result before lost ACK', exitCode: 0, cancelled: false, truncated: false };
  };
  const received = dropPartialReply(t);
  try {
    const request = callBridgeTool(f.bridge, 'batch', {
      operations: [{ op: 'command', args: { session_id: f.saved.id, command: 'fixture' } }],
    });
    await entered.promise;
    assert.equal((await received).output, 'result before lost ACK');
    assert.equal(
      (await f.call({ command: 'do not queue' })).structuredContent.reason,
      'BASH_IN_PROGRESS',
    );
    const result = (await request).structuredContent.results[0].result;
    assert.equal(result.status, 'unknown');
    assert.equal(result.output, 'result before lost ACK');
    assert.equal(
      result.response_complete,
      true,
      'Known output coverage is distinct from an uncertain final ACK',
    );
  } finally {
    finish.resolve();
  }
});

test('shutdown drains already admitted inline command output instead of discarding it', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    finish = Promise.withResolvers();
  f.rule.command = true;
  f.callbacks.bash = async ({ onResult }) => {
    const value = {
      output: 'known during shutdown',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    await onResult(value);
    entered.resolve();
    await finish.promise;
    return value;
  };
  const pending = f.call({ command: 'fixture' });
  await entered.promise;
  const closing = f.bridge.close();
  finish.resolve();
  const result = await pending;
  assert.equal(result.structuredContent.status, 'completed');
  assert.equal(result.structuredContent.output, 'known during shutdown');
  await closing;
});
