import { Bridge } from '../src/core/bridge.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callBridgeTool } from '../src/mcp/protocol.mjs';

const mockBridge = (methods) => ({
  captureRequestContext: async () => ({}),
  mutations: new Set(),
  lane: () => undefined,
  registerInput: Bridge.prototype.registerInput,
  ...methods,
});
const send = (session_id, text) => ({ op: 'send', args: { session_id, text } });

test('batch preserves result order, forks use their source lane, and other sessions proceed', async () => {
  const release = Promise.withResolvers(),
    independent = Promise.withResolvers(),
    calls = [];
  const bridge = mockBridge({
    async send({ text }) {
      calls.push(text);
      if (text === 'a1') await release.promise;
      if (text === 'b1') independent.resolve();
      return { text };
    },
    create: async () => (calls.push('fork'), { session_id: 'child' }),
  });
  const pending = callBridgeTool(bridge, 'batch', {
    operations: [
      send('a', 'a1'),
      { op: 'create', args: { project: '/project', fork_from: 'a' } },
      send('a', 'a2'),
      send('b', 'b1'),
    ],
  });
  await independent.promise;
  try {
    assert.deepEqual(calls, ['a1', 'b1']);
  } finally {
    release.resolve();
  }
  const { results } = (await pending).structuredContent;
  assert.deepEqual(calls, ['a1', 'b1', 'fork', 'a2']);
  assert.deepEqual(
    results.map(({ result }) => result.text ?? result.session_id),
    ['a1', 'child', 'a2', 'b1'],
  );
});

test('batch bounds malformed items and preserves independent outcomes and uncertainty', async () => {
  let calls = 0;
  const bridge = mockBridge({
    send: async ({ text }) => {
      if (text === 'lost-ack') throw Object.assign(new Error('ACK_TIMEOUT'), { uncertain: true });
      return { calls: ++calls };
    },
    read: async () => {
      throw new Error('NOT_FOUND_OR_DENIED');
    },
  });
  for (const input of [{ operations: [] }, { operations: [send('a', 'x')], extra: true }]) {
    const refused = await callBridgeTool(bridge, 'batch', input);
    assert.equal(refused.structuredContent.error.code, 'INVALID_ARGUMENTS');
    assert.equal(calls, 0);
  }
  const failedInput = send('a', 'lost-ack');
  const failed = await callBridgeTool(bridge, failedInput.op, failedInput.args);
  const { error } = failed.structuredContent;
  assert.ok(failed.isError);
  assert.deepEqual(JSON.parse(failed.content[0].text).error, error);
  assert.equal(error.code, 'ACK_TIMEOUT');
  assert.equal(error.uncertain, true);
  assert.match(error.recovery, /do not automatically resubmit/i);

  const batch = await callBridgeTool(bridge, 'batch', {
    operations: [
      send('a', 'one'),
      { op: 'read', args: { session_id: 'denied' } },
      failedInput,
      { op: 'x'.repeat(1000000), args: {} },
      null,
      { op: '__proto__', args: {} },
      send('a', ''),
      { op: 'batch', args: {} },
      send('a', 'two'),
    ],
  });
  const { results } = batch.structuredContent;
  assert.deepEqual(
    results.map(({ error, result }) => error?.code ?? result.calls),
    [1, 'NOT_FOUND_OR_DENIED', 'ACK_TIMEOUT', ...Array(5).fill('INVALID_OPERATION'), 2],
  );
  assert.deepEqual(results[2].error, error);
  assert.equal(results[3].error.op_truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(batch)) < 4096);
  assert.equal(bridge.mutations.size, 0);
});
