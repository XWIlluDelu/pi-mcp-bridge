import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { dropPartialReply } from './fixtures/drop-partial-reply.mjs';
import { withdrawalCollector, requestRpcStop } from '../src/stop-execution.mjs';
import { createSdkHostBinding, createRpcHostBinding } from '../src/host-bindings.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { makeServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { validateGrants } from '../src/owner-config.mjs';
const gate = () => Promise.withResolvers();
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stop-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, stop: true, create: true }],
  };
  let spawned = 0;
  const runtime = {
    alive: true,
    generation: 'offline-generation',
    state: async () => ({ isStreaming: false }),
    command: async () => ({ disposition: 'started' }),
    stop: async () => {
      runtime.alive = false;
    },
  };
  const bridge = await new Bridge(config, async () => {
    spawned++;
    return runtime;
  }).init();
  const made = await savedSession(bridge),
    saved = await bridge.session(made.session_id);
  let stops = 0;
  runtime.stopExecution = async ({ max_chars }) => {
    stops++;
    const withdrawn = withdrawalCollector(max_chars);
    return {
      status: 'accepted',
      acknowledgement: 'native_ack',
      coverage: 'agent_and_bash',
      withdrawal: withdrawn.add({ steering: ['one'], followUp: ['two'] }),
    };
  };
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup.reverse()) await close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    bridge,
    config,
    runtime,
    saved,
    id: saved.id,
    spawned: () => spawned,
    stops: () => stops,
    dir,
    cleanup,
  };
}
test('stop is independently authorized, live-only, replay-safe and retains session/process', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.bridge.stop({ session_id: f.id })).reason, 'not_running');
  assert.equal(f.spawned(), 0);
  await f.bridge.send({ session_id: f.id, text: 'start' });
  const args = { session_id: f.id };
  const replies = await Promise.all(Array.from({ length: 5 }, () => f.bridge.stop(args)));
  assert.equal(replies[0].withdrawn_text, 'one\n\ntwo');
  assert.equal(f.stops(), 5);
  assert.equal(f.runtime.alive, true);

  f.config.grants.push({ session_id: f.id, stop: false });
  await assert.rejects(f.bridge.stop({ ...args }), /NOT_FOUND_OR_DENIED/);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (await f.bridge.send({ session_id: f.id, text: 'later' })).status,
    ),
    'Expected native prompt admission',
  );
  f.config.grants.push({ session_id: f.id, stop: true, send: false });
  assert.equal((await f.bridge.stop({ ...args })).status, 'accepted');
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: 'no' })).reason,
    'NOT_FOUND_OR_DENIED',
  );
  f.config.grants.push({ session_id: f.id, read: false });
  assert.equal((await f.bridge.stop({ ...args })).withdrawn_text, 'one\n\ntwo');
  assert.equal((await f.bridge.stop(args)).withdrawn_text, 'one\n\ntwo');
  assert.equal(f.stops(), 8);
  assert.throws(
    () => validateGrants([{ folder: f.saved.cwd, command: 'yes' }]),
    /INVALID_OWNER_CONFIG/,
  );
});
test('stop bounds withdrawn text honestly', async (t) => {
  const f = await fixture(t),
    text = 'Unicode 😀 quote " slash \\ newline\n'.repeat(2500),
    tail = 'later prompt';
  let stops = 0;
  f.bridge.pool.instances.set(f.id, f.runtime);
  f.runtime.stopExecution = async ({ max_chars }) => {
    stops++;
    const withdrawn = withdrawalCollector(max_chars);
    return {
      status: 'accepted',
      acknowledgement: 'native_ack',
      coverage: 'agent_and_bash',
      withdrawal: withdrawn.add({ steering: [text], followUp: [tail] }),
    };
  };
  const args = { session_id: f.id, max_chars: 256 };
  const result = await f.bridge.stop(args);
  assert.equal(result.withdrawn_complete, false);
  assert.ok((text + '\n\n' + tail).startsWith(result.withdrawn_text));
  assert.ok(JSON.stringify({ withdrawn_text: result.withdrawn_text }).length <= 256);
  assert.equal(stops, 1);
});
test('stop fences new Bridge prompts, preserves withdrawn text on uncertain ACK, never retries control', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    finish = gate();
  f.bridge.pool.instances.set(f.id, f.runtime);
  f.cleanup.push(() => finish.resolve());
  let calls = 0;
  f.runtime.stopExecution = async () => {
    calls++;
    entered.resolve();
    await finish.promise;
    throw Object.assign(new Error('ACK_TIMEOUT'), {
      uncertain: true,
      result: { withdrawal: { text: 'recover me', includesEditorDraft: false, complete: false } },
    });
  };
  const args = { session_id: f.id },
    pending = f.bridge.stop(args);
  await entered.promise;
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: 'must not run' })).reason,
    'STOP_IN_PROGRESS',
  );
  finish.resolve();
  const receipt = await pending;
  assert.equal(receipt.status, 'unknown');
  assert.equal(receipt.withdrawn_text, 'recover me');

  assert.equal(calls, 1);
  assert.equal(f.runtime.alive, true);
});
test('stop rejects sends arriving behind an earlier prompt lock instead of deferring them past stop', async (t) => {
  const f = await fixture(t),
    admitted = gate(),
    finishPrompt = gate(),
    stopping = gate(),
    finishStop = gate(),
    queued = gate();
  f.cleanup.push(() => {
    finishPrompt.resolve();
    finishStop.resolve();
  });
  f.bridge.pool.instances.set(f.id, f.runtime);
  let sends = 0;
  f.runtime.command = async () => {
    if (++sends === 1) {
      admitted.resolve();
      await finishPrompt.promise;
    }
    return { disposition: 'started' };
  };
  const stop = f.runtime.stopExecution;
  f.runtime.stopExecution = async (args) => {
    stopping.resolve();
    await finishStop.promise;
    return stop(args);
  };
  const lock = f.bridge.mutationLock;
  t.mock.method(f.bridge, 'mutationLock', function (id, action, ...rest) {
    const result = lock.call(this, id, action, ...rest);
    if (action === 'send' && sends === 1) queued.resolve();
    return result;
  });
  const first = f.bridge.send({
    session_id: f.id,

    text: 'already entering Pi',
  });
  await admitted.promise;
  const cancel = f.bridge.stop({ session_id: f.id });
  await stopping.promise;
  const later = f.bridge.send({
    session_id: f.id,

    text: 'must not run after stop',
  });
  await queued.promise;
  finishStop.resolve();
  await cancel;
  finishPrompt.resolve();
  await first;
  const refusal = await later;
  assert.equal(refusal.reason, 'STOP_IN_PROGRESS');
  assert.equal(sends, 1);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'explicit new prompt',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal(sends, 2);
});
for (const op of ['send', 'command'])
  for (const stopFirst of [false, true])
    test(`owned ${op} refuses delayed dispatch ${stopFirst ? 'after' : 'during'} stop`, async (t) => {
      const f = await fixture(t),
        observing = gate(),
        finishState = gate(),
        stopping = gate(),
        finishStop = gate();
      f.cleanup.push(() => {
        finishState.resolve();
        finishStop.resolve();
      });
      f.config.grants[0].command = true;
      f.bridge.pool.instances.set(f.id, f.runtime);
      Object.assign(f.runtime, {
        command: PiRpc.prototype.command,
        executeBash: PiRpc.prototype.executeBash,
        assertSessionIdentity: PiRpc.prototype.assertSessionIdentity,
        activeBashes: 0,
        config: { attachmentDir: f.bridge.pool.attachmentDir },
        session: f.saved,
      });
      let reads = 0,
        dispatches = 0;
      f.runtime.state = async () => {
        if (++reads === 1) {
          observing.resolve();
          await finishState.promise;
        }
        return { sessionFile: f.saved.file, sessionId: f.saved.header.id, isStreaming: false };
      };
      f.runtime.dispatch = async (command) => {
        if (command.type === 'get_state') return f.runtime.state();
        dispatches++;
        return op === 'send'
          ? { disposition: 'started' }
          : { output: 'done', exitCode: 0, cancelled: false, truncated: false };
      };
      const stop = f.runtime.stopExecution;
      f.runtime.stopExecution = async (args) => {
        stopping.resolve();
        await finishStop.promise;
        return stop(args);
      };
      const args = {
        session_id: f.id,

        ...(op === 'send' ? { text: 'not dispatched' } : { command: 'not dispatched' }),
      };
      const input = f.bridge[op](args);
      await observing.promise;
      const cancel = f.bridge.stop({ session_id: f.id });
      await stopping.promise;
      if (stopFirst) {
        finishStop.resolve();
        await cancel;
      }
      finishState.resolve();
      const result = await input;
      finishStop.resolve();
      await cancel;
      assert.equal(result.reason, 'STOP_IN_PROGRESS');
      assert.equal(dispatches, 0);

      assert.equal(
        (await f.bridge[op]({ ...args })).status,
        op === 'send' ? 'started' : 'completed',
      );
      assert.equal(dispatches, 1);
    });
for (const op of ['send', 'command'])
  for (const stopFirst of [false, true])
    test(`host ${op} refuses delayed dispatch ${stopFirst ? 'after' : 'during'} stop`, async (t) => {
      const f = await fixture(t),
        observing = gate(),
        finishState = gate(),
        stopping = gate(),
        finishStop = gate();
      f.config.grants[0].command = true;
      const controller = await reserveHostSession({
        attachmentDir: f.bridge.pool.attachmentDir,
        session: f.saved,
      });
      f.cleanup.push(
        () => controller.close(),
        () => {
          finishState.resolve();
          finishStop.resolve();
        },
      );
      let dispatches = 0;
      const state = {
        sessionFile: f.saved.file,
        sessionId: f.saved.header.id,
        isIdle: true,
        isStreaming: false,
        isCompacting: false,
      };
      const binding = createRpcHostBinding({
        getState: async () => {
          observing.resolve();
          await finishState.promise;
          return state;
        },
        prompt: async () => {
          dispatches++;
          return 'started';
        },
        bash: async () => {
          dispatches++;
          return { output: 'done', exitCode: 0, cancelled: false, truncated: false };
        },
        clearQueue: async () => ({ steering: [], followUp: [] }),
        abort: async () => {},
        abortBash: async () => {},
      });
      await controller.ready({
        state: () => state,
        snapshot: () => ({ ...state, entries: [], leafId: null }),
        submit: binding.submit,
        bash: binding.bash,
        stop: async ({ onWithdraw }) => {
          await onWithdraw({ steering: [], followUp: [] });
          stopping.resolve();
          await finishStop.promise;
          return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
        },
      });
      const args = {
        session_id: f.id,

        ...(op === 'send'
          ? { text: 'not dispatched', mode: 'idle_only' }
          : { command: 'not dispatched' }),
      };
      const input = f.bridge[op](args);
      await observing.promise;
      const cancel = f.bridge.stop({ session_id: f.id });
      await stopping.promise;
      if (stopFirst) {
        finishStop.resolve();
        await cancel;
      }
      finishState.resolve();
      const result = await input;
      finishStop.resolve();
      await cancel;
      assert.equal(result.reason, 'STOP_IN_PROGRESS');
      assert.equal(dispatches, 0);

      assert.equal(
        (await f.bridge[op]({ ...args })).status,
        op === 'send' ? 'started' : 'completed',
      );
      assert.equal(dispatches, 1);
    });
test('native RPC withdrawal and both cancellation requests are submitted before waiting; settling inputs recovered', async () => {
  const calls = [],
    finish = gate(),
    snapshots = [];
  let cleared = 0;
  const client = {
    clearQueue: () => {
      calls.push('clear');
      return Promise.resolve({ steering: [++cleared === 1 ? 'early' : 'during'], followUp: [] });
    },
    abort: () => {
      calls.push('abort');
      return finish.promise;
    },
    abortBash: () => {
      calls.push('bash');
      return Promise.resolve();
    },
  };
  const stopping = requestRpcStop(client, async (value) => {
    snapshots.push(value);
  });
  assert.deepEqual(calls, ['clear', 'abort', 'bash']);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(snapshots[0].steering[0], 'early');
  finish.resolve();
  await stopping;
  assert.deepEqual(
    snapshots.map((value) => value.steering[0]),
    ['early', 'during'],
  );
});
for (const failure of ['clear', 'capture'])
  test('RPC Stop drains dispatched cancellations after ' + failure + ' failure', async () => {
    const abort = gate(),
      bash = gate(),
      failed = gate(),
      error = new Error('WITHDRAWAL_FAILED');
    let settled = false,
      clears = 0;
    const stopping = requestRpcStop(
      {
        clearQueue: async () => {
          clears++;
          if (failure === 'clear') {
            failed.resolve();
            throw error;
          }
          return { steering: [], followUp: [] };
        },
        abort: () => abort.promise,
        abortBash: () => bash.promise,
      },
      async () => {
        failed.resolve();
        throw error;
      },
    );
    const rejected = assert.rejects(stopping, (value) => value === error);
    void stopping
      .finally(() => {
        settled = true;
      })
      .catch(() => {});
    try {
      await failed.promise;
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'withdrawal failure must not finish active cancellation');
      abort.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'bash cancellation must drain too');
    } finally {
      abort.resolve();
      bash.resolve();
      await rejected;
    }
    assert.equal(clears, 1, 'failure must not replay withdrawal');
  });

test('SDK host keeps Stop admission fenced when withdrawal capture fails during cancellation', async (t) => {
  const f = await fixture(t),
    cancellation = gate(),
    capturing = gate(),
    controller = await reserveHostSession({
      attachmentDir: f.bridge.pool.attachmentDir,
      session: f.saved,
    });
  f.cleanup.push(() => controller.close());
  const state = {
    sessionFile: f.saved.file,
    sessionId: f.saved.header.id,
    isIdle: true,
    pendingMessageCount: 0,
  };
  let prompts = 0,
    settled = false;
  const binding = createSdkHostBinding({
    ...state,
    prompt: async () => {
      prompts++;
    },
    clearQueue: () => ({ steering: ['withdrawn'], followUp: [] }),
    abort: () => cancellation.promise,
    abortBash: () => {},
  });
  await controller.ready({
    state: binding.state,
    snapshot: async () => ({ ...state, entries: [], leafId: null }),
    submit: binding.submit,
    stop: (args) =>
      binding.stop({
        ...args,
        onWithdraw: async (value) => {
          await args.onWithdraw(value);
          capturing.resolve();
          throw new Error('CAPTURE_FAILED');
        },
      }),
  });
  const stopping = f.bridge.stop({ session_id: f.id }).finally(() => {
    settled = true;
  });
  try {
    await capturing.promise;
    await new Promise((resolve) => setImmediate(resolve));
    const sent = await f.bridge.send({ session_id: f.id, text: 'must not overlap cancellation' });
    assert.equal(sent.reason, 'STOP_IN_PROGRESS', JSON.stringify(sent));
    assert.equal(prompts, 0);
    assert.equal(settled, false);
  } finally {
    cancellation.resolve();
    await stopping;
  }
  const stopped = await stopping;
  assert.equal(stopped.status, 'unknown');
  assert.equal(stopped.withdrawn_text, 'withdrawn');
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: 'after cancellation' })).status,
    'dispatched',
  );
  assert.equal(prompts, 1);
});

test('generic public SDK and RPC bindings withdraw and cancel without invoking release', async () => {
  const state = { sessionFile: '/synthetic/session.jsonl', sessionId: 'native' },
    captured = [],
    calls = [];
  const session = {
    ...state,
    clearQueue: () => {
      calls.push('clear');
      return { steering: ['queued'], followUp: [] };
    },
    abort: async () => {
      calls.push('abort');
    },
    abortBash: () => {
      calls.push('bash');
    },
  };
  const sdk = createSdkHostBinding(session, { release: () => assert.fail('not release') });
  await sdk.stop({
    ...state,
    onWithdraw: async (value) => {
      captured.push(value);
    },
  });
  assert.deepEqual(calls, ['clear', 'abort', 'bash', 'clear']);
  assert.equal(captured[0].steering[0], 'queued');
  calls.length = 0;
  const rpc = createRpcHostBinding({ ...session, getState: async () => state });
  await rpc.stop({ ...state, onWithdraw: async () => {} });
  assert.deepEqual(calls, ['clear', 'abort', 'bash', 'clear']);
  await assert.rejects(
    rpc.stop({ ...state, sessionId: 'wrong', onWithdraw: async () => {} }),
    /RUNTIME_SESSION_CHANGED/,
  );
  delete session.abortBash;
  await assert.rejects(
    createSdkHostBinding(session).stop({ ...state, onWithdraw: async () => {} }),
    /STOP_UNSUPPORTED/,
  );
});
test('generic host IPC and actual MCP return joined editor recovery; missing callback is explicitly unsupported', async (t) => {
  const f = await fixture(t),
    controller = await reserveHostSession({
      attachmentDir: f.bridge.pool.attachmentDir,
      session: f.saved,
    });
  f.cleanup.push(() => controller.close());
  const state = () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id, isIdle: true });
  const callbacks = {
    state,
    snapshot: () => ({ ...state(), entries: [], leafId: null }),
    submit: async () => ({ status: 'accepted' }),
  };
  await controller.ready(callbacks);
  const client = new Client({ name: 'stop-test', version: '1' }),
    server = makeServer(f.bridge),
    [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  f.cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const tools = await client.listTools();
  assert.ok(tools.tools.find((tool) => tool.name === 'stop'));
  const call = async (label, extra = {}) =>
    (await client.callTool({ name: 'stop', arguments: { session_id: f.id, ...extra } }))
      .structuredContent;
  assert.equal((await call('unsupported')).reason, 'STOP_UNSUPPORTED');
  assert.equal(f.spawned(), 0);
  callbacks.stop = async ({ onWithdraw }) => {
    await onWithdraw({ text: 'first\n\nsecond\n\nexisting draft', includesEditorDraft: true });
    return { status: 'accepted', acknowledgement: 'requested', coverage: 'agent_and_bash' };
  };
  const result = await call('host-stop');
  assert.equal(result.withdrawn_text, 'first\n\nsecond\n\nexisting draft');
  assert.equal(result.includes_editor_draft, true);
  assert.equal(result.acknowledgement, 'requested');
  assert.equal(result.completion, undefined);
  assert.equal(f.spawned(), 0);
  const finished = gate();
  let calls = 0;
  f.cleanup.push(() => finished.resolve());
  callbacks.stop = async ({ onWithdraw }) => {
    calls++;
    await onWithdraw({ steering: ['withdrawn before socket timeout'], followUp: [] });
    await finished.promise;
    return { status: 'accepted', acknowledgement: 'native_ack', coverage: 'agent_and_bash' };
  };
  const received = dropPartialReply(t);
  try {
    const pending = call('socket-lost');
    assert.equal((await received).withdrawal.text, 'withdrawn before socket timeout');
    const lost = await pending;
    assert.equal(lost.status, 'unknown');
    assert.equal(lost.withdrawn_text, 'withdrawn before socket timeout');

    assert.equal(calls, 1);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'no admission' })).reason,
      'STOP_IN_PROGRESS',
    );
  } finally {
    finished.resolve();
  }
});
