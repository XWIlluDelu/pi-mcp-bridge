import { ownedRuntime } from './fixtures/owned-runtime.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';

import { withdrawalCollector, requestStop } from '../src/stop-execution.mjs';
import { sdkSession } from './fixtures/sdk-session.mjs';
import { createSdkHostBinding } from '../src/host-bindings.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';

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
  const runtime = ownedRuntime({
    alive: true,
    generation: 'offline-generation',
    state: async () => ({ isStreaming: false }),
    command: async () => ({ disposition: 'started' }),
    stop: async () => {
      runtime.alive = false;
    },
  });
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
  const stopping = requestStop(client, async (value) => {
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
for (const failure of ['clear', 'capture', 'abort'])
  test('Stop drains dispatched cancellations after ' + failure + ' failure', async () => {
    const abort = gate(),
      bash = gate(),
      failed = gate(),
      error = new Error('WITHDRAWAL_FAILED');
    let settled = false,
      clears = 0;
    const stopping = requestStop(
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
        if (failure === 'capture') throw error;
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
      if (failure === 'abort') abort.reject(error);
      else if (failure === 'capture') abort.reject(new Error('ABORT_FAILED'));
      else abort.resolve();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(settled, false, 'bash cancellation must drain too');
    } finally {
      abort.resolve();
      bash.resolve();
      await rejected;
    }
    assert.equal(clears, 1, 'failure must not replay withdrawal');
  });

for (const failure of ['capture', 'bash'])
  test(`SDK host keeps Stop admission fenced after ${failure} failure`, async (t) => {
    const f = await fixture(t),
      cancellation = gate(),
      capturing = gate(),
      controller = await reserveHostSession({
        buildSessionProjection: hostProjection,
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
    const binding = createSdkHostBinding(
      sdkSession({
        ...state,
        prompt: async () => {
          prompts++;
        },
        clearQueue: () => ({ steering: ['withdrawn'], followUp: [] }),
        abort: () => cancellation.promise,
        abortBash: () => {
          if (failure === 'bash') {
            capturing.resolve();
            throw new Error('BASH_FAILED');
          }
        },
      }),
    );
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
            if (failure === 'capture') throw new Error('CAPTURE_FAILED');
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
      cancellation.reject(new Error('ABORT_FAILED'));
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
