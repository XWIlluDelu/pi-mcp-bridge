import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, preflightBatch } from '../src/batch.mjs';
const send = (session_id, request_id) => ({
  op: 'send',
  args: { session_id, request_id, text: 'hello' },
});
test('batch is a transparent wrapper with per-item validation and original-order results', async () => {
  const calls = [],
    bridge = {
      send: async (args) => {
        calls.push(args.request_id);
        return { status: 'accepted' };
      },
      read: async () => {
        throw new Error('NOT_FOUND_OR_DENIED');
      },
      health: async () => ({ ok: true }),
    };
  const result = await executeBatch(bridge, {
    operations: [
      send('a', 'one'),
      { op: 'read', args: { session_id: 'denied' } },
      null,
      { op: 'batch', args: {} },
      { op: 'health', args: { domain: 'permissions' } },
      send('a', 'two'),
    ],
  });
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(
    result.results.map((x) => x.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(result.results[1].error.code, 'NOT_FOUND_OR_DENIED');
  assert.equal(result.results[2].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[3].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[4].result.ok, true);
});
test('different sessions progress independently while each session retains input order', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    events = [];
  const bridge = {
    send: async (args) => {
      events.push(args.request_id);
      if (args.request_id === 'a1') {
        entered.resolve();
        await release.promise;
      }
      return { status: 'accepted' };
    },
  };
  const pending = executeBatch(bridge, {
    operations: [send('a', 'a1'), send('a', 'a2'), send('b', 'b1')],
  });
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1', 'b1']);
  release.resolve();
  await pending;
  assert.deepEqual(events, ['a1', 'b1', 'a2']);
});
test('outer size/shape bounds reject before any operation but bad item args do not', async () => {
  let calls = 0;
  const bridge = {
    send: async () => {
      calls++;
      return { status: 'accepted' };
    },
  };
  for (const input of [
    { operations: [] },
    { operations: Array.from({ length: 11 }, () => send('a', 'x')) },
    { operations: [send('a', 'x')], extra: true },
  ]) {
    assert.equal((await executeBatch(bridge, input)).status, 'rejected');
    assert.equal(calls, 0);
  }
  const result = await executeBatch(bridge, {
    operations: [
      { op: 'send', args: { session_id: 'a', request_id: 'bad', text: '', mode: 'invented' } },
      send('a', 'good'),
    ],
  });
  assert.equal(result.results[0].error.code, 'INVALID_OPERATION');
  assert.equal(calls, 1);
  assert.ok(preflightBatch({ operations: [null] }).operations);
});
test('fork shares its source lane; list and health do not add mutation permissions', async () => {
  const events = [],
    bridge = {
      send: async () => {
        events.push('send');
      },
      create: async () => {
        events.push('fork');
        return { session_id: 'child' };
      },
      list: async () => ({ sessions: [] }),
      health: async () => ({ ok: true }),
    };
  const result = await executeBatch(bridge, {
    operations: [
      send('parent', 's'),
      {
        op: 'create',
        args: { project: '/project', fork_from: 'parent', request_id: 'fork', text: 'first' },
      },
      { op: 'list', args: {} },
      { op: 'health', args: { domain: 'runtime' } },
    ],
  });
  assert.deepEqual(events, ['send', 'fork']);
  assert.equal(result.results.length, 4);
});
