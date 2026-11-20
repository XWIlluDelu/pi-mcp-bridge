import test from 'node:test';
import assert from 'node:assert/strict';
import { callBridgeTool } from '../src/mcp/protocol.mjs';
import { executeBatch } from '../src/mcp/batch.mjs';
import { Bridge } from '../src/core/bridge.mjs';

test('single and batch mutation errors preserve uncertainty and independent outcomes', async () => {
  const failure = () => Object.assign(new Error('ACK_TIMEOUT'), { uncertain: true });
  const bridge = {
    captureRequestContext: async () => ({}),
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
  const { error } = result.structuredContent;
  assert.deepEqual(JSON.parse(result.content[0].text).error, error);
  assert.equal(error.code, 'ACK_TIMEOUT');
  assert.equal(error.uncertain, true);
  const batch = await executeBatch(bridge, {
    operations: [
      { op: 'send', args },
      { op: 'list', args: {} },
    ],
  });
  assert.equal(bridge.inputs.size, 0);
  assert.deepEqual(batch.results[0].error, error);
  assert.match(error.recovery, /do not automatically resubmit/i);
  assert.deepEqual(batch.results[1].result, { sessions: [] });
});

test('a huge malformed operation name cannot consume the batch response or hide later outcomes', async () => {
  let calls = 0;
  const result = await executeBatch(
    {
      captureRequestContext: async () => ({}),
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
