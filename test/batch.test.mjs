import { Bridge } from '../src/bridge.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callBridgeTool } from '../src/protocol.mjs';

const mockBridge = (methods) => ({
  inputs: new Set(),
  locks: new Map(),
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

test('malformed batch items fail independently and outer shape errors admit no work', async () => {
  let calls = 0;
  const bridge = mockBridge({
    send: async () => ({ calls: ++calls }),
    read: async () => {
      throw new Error('NOT_FOUND_OR_DENIED');
    },
  });
  for (const input of [{ operations: [] }, { operations: [send('a', 'x')], extra: true }]) {
    const refused = await callBridgeTool(bridge, 'batch', input);
    assert.equal(refused.structuredContent.error.code, 'INVALID_ARGUMENTS');
    assert.equal(calls, 0);
  }
  const { results } = (
    await callBridgeTool(bridge, 'batch', {
      operations: [
        send('a', 'one'),
        { op: 'read', args: { session_id: 'denied' } },
        null,
        { op: '__proto__', args: {} },
        send('a', ''),
        { op: 'batch', args: {} },
        send('a', 'two'),
      ],
    })
  ).structuredContent;
  assert.deepEqual(
    results.map(({ error, result }) => error?.code ?? result.calls),
    [1, 'NOT_FOUND_OR_DENIED', ...Array(4).fill('INVALID_OPERATION'), 2],
  );
});
