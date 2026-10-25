import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc } from '../src/rpc.mjs';

test('settlement advances only for the current generation and preserves pending admission', () => {
  const rpc = new PiRpc({}, {});
  rpc.receiveResponse({ type: 'agent_start' }, rpc.generation);
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, 'retired-generation');
  rpc.receiveResponse({ type: 'agent_settled' }, rpc.generation);
  assert.equal(rpc.settlementSequence, 0);
  assert.equal(rpc.hasUnsettledWork(), true);
  rpc.promptAdmission = { id: 'unresolved', generation: rpc.generation };
  rpc.receiveResponse({ type: 'agent_settled', aborted: false }, rpc.generation);
  assert.equal(rpc.settlementSequence, 1);
  assert.equal(rpc.promptAdmission.id, 'unresolved');
  assert.equal(rpc.hasUnsettledWork(), true);
  rpc.promptAdmission = null;
  assert.equal(rpc.hasUnsettledWork(), false);
  rpc.receiveResponse({ type: 'agent_start' }, rpc.generation);
  rpc.receiveResponse({ type: 'agent_settled', aborted: true }, rpc.generation);
  assert.equal(rpc.settlementSequence, 2);
  assert.equal(rpc.hasUnsettledWork(), false);
  const replacement = new PiRpc({}, {});
  assert.notEqual(replacement.generation, rpc.generation);
  assert.equal(replacement.settlementSequence, 0);
});
