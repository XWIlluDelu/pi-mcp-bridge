import test from 'node:test';
import assert from 'node:assert/strict';
import { observeRpcInputs } from '../src/rpc-input-activity.mjs';
import { PiRpc } from '../src/rpc.mjs';

test('input observation preserves native dispatch and failures, with per-session counts across reload', async () => {
  const gate = Promise.withResolvers(),
    otherGate = Promise.withResolvers(),
    failure = new Error('native failure'),
    changes = [];
  class Native {
    constructor(manager) {
      this.sessionManager = manager;
    }
    prompt(value) {
      if (value === 'throw') throw failure;
      if (value === 'reject') return Promise.reject(failure);
      return value.promise;
    }
    steer(value) {
      return this.prompt(value);
    }
    followUp(value) {
      return this.prompt(value);
    }
    sendCustomMessage(value) {
      return this.prompt(value);
    }
  }
  const first = new Native({}),
    second = new Native({});
  let snapshot = observeRpcInputs(Native, (manager, state) => changes.push({ manager, ...state }));
  const a = first.prompt(gate),
    b = second.prompt(otherGate);
  assert.deepEqual(snapshot(first.sessionManager), { pendingInputs: 1, sequence: 1 });
  assert.deepEqual(snapshot(second.sessionManager), { pendingInputs: 1, sequence: 1 });
  // Factory replacement must neither wrap twice nor forget unfinished calls.
  snapshot = observeRpcInputs(Native, (manager, state) => changes.push({ manager, ...state }));
  gate.resolve('native result');
  assert.equal(await a, 'native result');
  assert.equal(snapshot(first.sessionManager).pendingInputs, 0);
  assert.equal(snapshot(second.sessionManager).pendingInputs, 1);
  assert.throws(
    () => first.prompt('throw'),
    (e) => e === failure,
  );
  await assert.rejects(first.prompt('reject'), (e) => e === failure);
  assert.deepEqual(snapshot(first.sessionManager), { pendingInputs: 0, sequence: 6 });
  otherGate.resolve();
  await b;
  assert.equal(snapshot(second.sessionManager).pendingInputs, 0);
  assert.deepEqual(
    changes.filter((c) => c.manager === first.sessionManager).map((c) => c.pendingInputs),
    [1, 0, 1, 0, 1, 0],
  );
});

test('out-of-order activity cannot clear newer work or revive completed input', () => {
  const rpc = new PiRpc({}, {});
  rpc.observeInputActivity({ pendingInputs: 1, sequence: 3 });
  rpc.observeInputActivity({ pendingInputs: 0, sequence: 2 });
  assert.equal(rpc.hasUnsettledWork(), true);
  rpc.observeInputActivity({ pendingInputs: 0, sequence: 4 });
  rpc.observeInputActivity({ pendingInputs: 1, sequence: 3 });
  assert.equal(rpc.hasUnsettledWork(), false);
});
