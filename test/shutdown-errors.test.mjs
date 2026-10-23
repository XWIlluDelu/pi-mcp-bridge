import test from 'node:test';
import assert from 'node:assert/strict';
import { callBridgeTool } from '../src/protocol.mjs';
import { executeBatch } from '../src/batch.mjs';
import { Bridge } from '../src/bridge.mjs';

test('single and batch mutation errors preserve uncertainty and independent outcomes', async () => {
  const failure = () => Object.assign(new Error('ACK_TIMEOUT'), { uncertain: true });
  const bridge = {
    inputs: new Set(),
    locks: new Map(),
    registerInput: Bridge.prototype.registerInput,
    async send() {
      throw failure();
    },
    async list() {
      return { sessions: [] };
    },
  };
  const args = { session_id: 'known', text: 'fixture' };
  const result = await callBridgeTool(bridge, 'send', args);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text).error, {
    code: 'ACK_TIMEOUT',
    uncertain: true,
    recovery:
      'OUTCOME_UNKNOWN; inspect list/read before deciding whether to submit again. No automatic replay.',
  });
  const batch = await executeBatch(bridge, {
    operations: [
      { op: 'send', args },
      { op: 'list', args: {} },
    ],
  });
  assert.equal(bridge.inputs.size, 0);
  assert.equal(batch.results[0].error.uncertain, true);
  assert.match(batch.results[0].error.recovery, /do not automatically resubmit/i);
  assert.deepEqual(batch.results[1].result, { sessions: [] });
});

test('a huge malformed operation name cannot consume the batch response or hide later outcomes', async () => {
  let calls = 0;
  const result = await executeBatch(
    {
      async list() {
        calls++;
        return { sessions: [] };
      },
    },
    {
      operations: [
        { op: 'x'.repeat(1000000), args: {} },
        { op: 'list', args: {} },
      ],
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.results[0].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[0].error.op_truncated, true);
  assert.deepEqual(result.results[1].result, { sessions: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
});
