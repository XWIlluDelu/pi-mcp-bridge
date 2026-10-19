import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, BATCH_RESPONSE_LIMIT } from '../src/batch.mjs';
import { renderContextRead } from '../src/context-read.mjs';
import { TOOL_RESULT_LIMIT, toolResultBytes } from '../src/response-budget.mjs';
test('batch caps the full duplicated UTF8 result and continues captured reads without rereading', async () => {
  let reads = 0,
    deleted = false;
  const data = {
    header: { id: 'native' },
    entries: [
      {
        type: 'message',
        id: 'p',
        parentId: null,
        message: { role: 'user', content: '漢😀"\\\n'.repeat(20000) },
      },
    ],
    leafId: 'p',
  };
  const bridge = {
    read: async (args) => {
      reads++;
      assert.equal(deleted, false);
      return renderContextRead(data, args);
    },
    delete: async () => {
      deleted = true;
      return { status: 'deleted' };
    },
  };
  const operations = Array.from({ length: 8 }, (_, i) => ({
    op: 'read',
    args: { session_id: 'session', max_bytes: 65536 },
  }));
  operations.push({ op: 'delete', args: { session_id: 'session', request_id: 'delete' } });
  const result = await executeBatch(bridge, { operations });
  assert.equal(reads, 8);
  assert.equal(deleted, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= BATCH_RESPONSE_LIMIT);
  assert.ok(toolResultBytes(result) <= TOOL_RESULT_LIMIT);
  for (const item of result.results.slice(0, 8)) {
    assert.ok(item.result.next_cursor);
    assert.equal(item.result.format, 'context_timeline');
  }
  assert.equal(result.results.at(-1).result.status, 'deleted');
});
test('oversized mutation output has explicit recovery identity, never reruns the mutation', async () => {
  let calls = 0;
  const bridge = {
    command: async () => {
      calls++;
      return { status: 'accepted', output: '😀'.repeat(100000) };
    },
  };
  const result = await executeBatch(bridge, {
    operations: [
      { op: 'command', args: { session_id: 's', request_id: 'once', command: 'fixture' } },
    ],
  });
  assert.equal(calls, 1);
  assert.equal(result.results[0].error.code, 'BATCH_RESULT_OMITTED');
  assert.deepEqual(result.results[0].recovery, { request_id: 'once', session_id: 's' });
  assert.ok(toolResultBytes(result) <= TOOL_RESULT_LIMIT);
});
