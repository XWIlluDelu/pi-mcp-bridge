import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc } from '../src/rpc.mjs';
import { rpcActivity } from '../src/activity.mjs';

test('settled observations are session-wide, cloned, and scoped to the exact runtime generation', () => {
  const rpc = new PiRpc({}, {});
  const initial = { ...rpc.settlement };
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, 'retired-generation');
  rpc.receiveResponse({ type: 'agent_settled' }, rpc.generation);
  assert.deepEqual(rpc.settlement, initial);
  rpc.promptAdmission = { id: 'unresolved', generation: rpc.generation };
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, rpc.generation);
  const observed = rpcActivity({ isStreaming: false, pendingMessageCount: 0 }, true, rpc.settlement);
  assert.equal(observed.settlement.sequence, 1);
  assert.equal(observed.settlement.aborted, false);
  assert.ok(Number.isFinite(Date.parse(observed.settlement.observed_at)));
  assert.equal(observed.idle, null);
  assert.equal(observed.bridge_admission.pending, true);
  assert.equal(rpc.promptAdmission.id, 'unresolved');
  rpc.receiveResponse({ type: 'agent_settled', aborted: true }, rpc.generation);
  assert.equal(rpc.settlement.sequence, 2);
  assert.equal(rpc.settlement.aborted, true);
  assert.equal(observed.settlement.sequence, 1);
  const replacement = new PiRpc({}, {});
  assert.notEqual(replacement.generation, rpc.generation);
  assert.equal(replacement.settlement.sequence, 0);
  assert.equal(replacement.settlement.observed_at, null);
});
