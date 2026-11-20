import { nativeOwner } from './fixtures/native-owner.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PiRpc } from '../src/runtime/rpc.mjs';

import { withdrawalCollector, requestStop } from '../src/ops/stop-execution.mjs';
import { sdkSession } from './fixtures/sdk-session.mjs';
import { createSdkHostBinding } from '../src/runtime/host-bindings.mjs';
import { reserveHostSession } from '../src/runtime/host-adapter.mjs';

const gate = () => Promise.withResolvers();
async function fixture(t) {
  let spawned = 0,
    stops = 0;
  const runtime = ownedRuntime({
    generation: 'offline-generation',
    state: async () => ({ isStreaming: false }),
    command: async () => ({ disposition: 'started' }),
    stop: async () => {
      runtime.alive = false;
    },
    stopExecution: async ({ max_chars }) => {
      stops++;
      return {
        status: 'accepted',
        acknowledgement: 'native_ack',
        coverage: 'agent_and_bash',
        withdrawal: withdrawalCollector(max_chars).add({ steering: ['one'], followUp: ['two'] }),
      };
    },
  });
  const f = await nativeOwner(t, {
    prefix: 'stop-api',
    factory: async () => {
      spawned++;
      return runtime;
    },
  });
  return { ...f, runtime, spawned: () => spawned, stops: () => stops };
}
test('stop is independently authorized, live-only, replay-safe and retains session/process', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.bridge.stop({ session_id: f.id })).reason, 'not_running');
  assert.equal(f.spawned(), 0);
  await f.bridge.send({ session_id: f.id, text: 'start' });
  const args = { session_id: f.id };
  assert.equal((await f.bridge.stop(args)).withdrawn_text, 'one\n\ntwo');
  f.config.grants.push({ session_id: f.id, stop: false });
  await assert.rejects(f.bridge.stop(args), /NOT_FOUND_OR_DENIED/);
  f.config.grants.push({ session_id: f.id, stop: true, send: false, read: false });
  assert.equal((await f.bridge.stop(args)).withdrawn_text, 'one\n\ntwo');
  assert.equal((await f.bridge.send({ ...args, text: 'denied' })).reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(f.stops(), 2);
  assert.equal(f.runtime.alive, true);
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
        session: f.session,
      });
      let held = false;
      f.runtime.state = async () => {
        if (!held) {
          held = true;
          observing.resolve();
          await finishState.promise;
        }
        return { sessionFile: f.session.file, sessionId: f.session.header.id, isStreaming: false };
      };
      f.runtime.dispatch = (command) => {
        assert.equal(command.type, 'get_state', 'a withdrawn input cannot dispatch');
        return f.runtime.state();
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
      assert.equal((await input).reason, 'STOP_IN_PROGRESS');
      finishStop.resolve();
      await cancel;
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

test('SDK host keeps Stop fenced through partial withdrawal and cancellation failure', async (t) => {
  const f = await fixture(t),
    cancellation = gate(),
    captured = gate();
  const controller = await reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: f.config.attachmentDir,
    session: f.session,
  });
  f.cleanup.push(
    () => cancellation.resolve(),
    () => controller.close(),
  );
  const binding = createSdkHostBinding(
    sdkSession({
      sessionFile: f.session.file,
      sessionId: f.session.header.id,
      isIdle: true,
      clearQueue: () => ({ steering: ['withdrawn'], followUp: [] }),
      abort: () => cancellation.promise,
      abortBash: () => {},
    }),
  );
  await controller.ready({
    ...binding,
    stop: (args) =>
      binding.stop({
        ...args,
        onWithdraw: async (value) => {
          await args.onWithdraw(value);
          captured.resolve();
          throw new Error('CAPTURE_FAILED');
        },
      }),
  });
  const send = () => f.bridge.send({ session_id: f.id, text: 'prompt' });
  const stopping = f.bridge.stop({ session_id: f.id });
  await captured.promise;
  assert.equal((await send()).reason, 'STOP_IN_PROGRESS');
  cancellation.reject(new Error('ABORT_FAILED'));
  const stopped = await stopping;
  assert.equal(stopped.status, 'unknown');
  assert.equal(stopped.withdrawn_text, 'withdrawn');
  assert.equal((await send()).status, 'dispatched');
});
