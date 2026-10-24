import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { makeServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateGrants } from '../src/owner-config.mjs';
import { dropPartialReply } from './fixtures/drop-partial-reply.mjs';
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bash-api-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const rule = { folder: cwd, list: true, read: true, send: true, stop: true, create: true },
    config = {
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: cwd }],
      grants: [rule],
    };
  const bridge = await new Bridge(config, async () => assert.fail('no fallback writer')).init();
  const made = await savedSession(bridge),
    saved = await bridge.session(made.session_id);
  const controller = await reserveHostSession({
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
  const client = new Client({ name: 'direct-bash-api-fixture', version: '1' }),
    server = makeServer(bridge),
    [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  t.after(async () => {
    await client.close();
    await server.close();
    await controller.close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const call = async (args) =>
    client.callTool({ name: 'command', arguments: { session_id: saved.id, ...args } });
  return { bridge, config, rule, saved, client, call, calls: () => calls, callbacks, output };
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
  assert.equal((await f.call({ command: 'native command', max_chars: 32768 })).isError, undefined);
  assert.equal(f.calls(), 2);
});
test('command and batch distinguish native truncation from response completeness', async (t) => {
  const f = await fixture(t);
  f.rule.command = true;
  const output = 'native output line\n'.repeat(100);
  for (const native_truncated of [false, true]) {
    f.callbacks.bash = async () => ({
      output,
      exitCode: 0,
      cancelled: false,
      truncated: native_truncated,
      fullOutputPath: native_truncated ? '/synthetic/native-output.log' : null,
    });
    for (const max_chars of [256, 32768]) {
      const args = { session_id: f.saved.id, command: 'native fixture', max_chars };
      const direct = await f.client.callTool({ name: 'command', arguments: args });
      const batch = await f.client.callTool({
        name: 'batch',
        arguments: { operations: [{ op: 'command', args }] },
      });
      for (const result of [direct.structuredContent, batch.structuredContent.results[0].result]) {
        assert.equal(result.status, 'accepted');
        assert.equal(result.native_truncated, native_truncated);
        assert.equal(result.response_complete, max_chars === 32768);
        assert.equal(result.output, output.slice(0, result.output.length));
        assert.equal(
          result.fullOutputPath,
          native_truncated ? '/synthetic/native-output.log' : null,
        );
        assert.ok(!('truncated' in result));
        assert.ok(!('output_complete' in result));
      }
    }
  }
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
    const request = f.client.callTool({
      name: 'batch',
      arguments: {
        operations: [{ op: 'command', args: { session_id: f.saved.id, command: 'fixture' } }],
      },
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

test('bash respects the handoff fence before and after runtime lookup', async (t) => {
  const f = await fixture(t);
  f.rule.command = true;
  f.bridge.handoffs.set(f.saved.id, {});
  let result = (await f.call({ command: 'not admitted' })).structuredContent;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'HANDOFF_PENDING');
  assert.equal(f.calls(), 0);
  f.bridge.handoffs.delete(f.saved.id);
  const entered = Promise.withResolvers(),
    finish = Promise.withResolvers(),
    lookup = f.bridge.pool.forRead.bind(f.bridge.pool);
  t.mock.method(f.bridge.pool, 'forRead', async (session) => {
    const runtime = await lookup(session);
    entered.resolve();
    await finish.promise;
    return runtime;
  });
  const pending = f.call({ command: 'not admitted' });
  await entered.promise;
  f.bridge.handoffs.set(f.saved.id, {});
  finish.resolve();
  result = (await pending).structuredContent;
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'HANDOFF_PENDING');
  assert.equal(f.calls(), 0);
  f.bridge.handoffs.delete(f.saved.id);
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
  assert.equal(result.structuredContent.status, 'accepted');
  assert.equal(result.structuredContent.output, 'known during shutdown');
  await closing;
});
