import { nativeOwner } from './fixtures/native-owner.mjs';
import { message, text } from './fixtures/native-history.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { Bridge } from '../src/bridge.mjs';
import { ContextReadCache } from '../src/read-cache.mjs';

import { prepareContextRead } from './fixtures/read-pages.mjs';
import { callBridgeTool } from '../src/protocol.mjs';

async function fixture(t) {
  const f = await nativeOwner(t, { prefix: 'read-cache', factory: () => assert.fail('No writer') });
  const entries = [
    message('u', null, 'user', 'task'),
    message('a', 'u', 'assistant', [text('page evidence '.repeat(1500))]),
  ];
  f.bridge.pool.forRead = async () => ({
    generation: 'fixture',
    read: (args) => prepareContextRead({ entries, leafId: 'a' }, args),
  });
  return { ...f, entries };
}

async function sourcePage(f, args = {}) {
  const overview = await f.bridge.read({ session_id: f.id, ...args });
  const ref = overview.items.find((item) => item.type === 'assistant').ref;
  return f.bridge.read({ refs: [ref], max_bytes: 4096 });
}

test('eviction and restart return stale cursors without reconstructing snapshots', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxEntries: 1 });
  const first = await sourcePage(f);
  await f.bridge.read({ session_id: f.id, content: { thinking: 0 } });
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /STALE_CURSOR/);
  const fresh = await sourcePage(f);
  await f.bridge.close();
  const restarted = await new Bridge(f.config, () => assert.fail('No writer')).init();
  try {
    await assert.rejects(restarted.read({ cursor: fresh.next_cursor }), /STALE_CURSOR/);
  } finally {
    await restarted.close();
  }
});

test('snapshot admission failure does not issue unusable references or narrow content', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxBytes: 4096 });
  await assert.rejects(f.bridge.read({ session_id: f.id }), /READ_SNAPSHOT_TOO_LARGE/);
  assert.equal(f.bridge.readCache.entries.size, 0);
  assert.equal(f.bridge.readCache.accountedBytes, 0);
  const denied = await callBridgeTool(f.bridge, 'read', { session_id: f.id });
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'READ_SNAPSHOT_TOO_LARGE');
  f.bridge.readCache = new ContextReadCache();
  f.entries[1].message.content[0].text = ('x'.repeat(1000) + '\n\n').repeat(9000);
  await assert.rejects(f.bridge.read({ session_id: f.id }), /READ_SNAPSHOT_TOO_LARGE/);
  assert.equal(f.bridge.readCache.entries.size, 0);
});

test('batch reference snapshots remain pinned until assembly', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxEntries: 1 });
  const response = await callBridgeTool(f.bridge, 'batch', {
    operations: [
      { op: 'read', args: { session_id: f.id, max_bytes: 4096 } },
      { op: 'read', args: { session_id: f.id, max_bytes: 4096 } },
    ],
  });
  const [first, second] = response.structuredContent.results;
  const ref = first.result.items.find((item) => item.type === 'assistant').ref;
  assert.equal(second.error.code, 'READ_CACHE_BUSY');
  const expanded = await f.bridge.read({ refs: [ref] });
  assert.equal(expanded.leaf_id, first.result.leaf_id);
  assert.ok([...f.bridge.readCache.entries.values()].every((entry) => entry.pins === 0));
});

test('cursor overrides validate supplied scope values and native identity', async (t) => {
  const f = await fixture(t),
    first = await sourcePage(f, {
      range: { recent: -1 },
      content: { assistant: 1, tool: 0, thinking: 0, command: 0 },
    });
  const next = await f.bridge.read({
    cursor: first.next_cursor,
    content: { tool: 0 },
    max_bytes: 8192,
  });
  assert.deepEqual(next.selection, first.selection);
  for (const patch of [{ content: { tool: -1 } }, { range: { recent: 3 } }, { leaf_id: null }])
    await assert.rejects(f.bridge.read({ cursor: first.next_cursor, ...patch }), /STALE_CURSOR/);
  await fs.writeFile(
    f.session.file,
    JSON.stringify({ ...f.session.header, id: 'different-native-id' }) + '\n',
  );
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /NOT_FOUND_OR_DENIED/);
});

test('batched references preserve source order across a steering boundary and a paired result', async (t) => {
  const f = await fixture(t);
  f.entries.splice(
    0,
    f.entries.length,
    message('u', null, 'user', 'First request'),
    message('call', 'u', 'assistant', [
      { type: 'toolCall', id: 'c', name: 'read', arguments: { path: 'file' } },
    ]),
    message('steer', 'call', 'user', 'New direction'),
    message('result', 'steer', 'toolResult', [{ type: 'text', text: 'Evidence' }], {
      toolCallId: 'c',
      toolName: 'read',
    }),
    message('a', 'result', 'assistant', [{ type: 'text', text: 'Reply' }]),
  );
  const overview = await f.bridge.read({ session_id: f.id, content: { tool: -1 } });
  const tool = overview.items.find((item) => item.type === 'tool');
  const input = overview.items.find((item) => item.source?.entry_id === 'steer');
  const expanded = await f.bridge.read({ refs: [input.ref, tool.ref] });
  assert.deepEqual(
    expanded.items.map((item) => item.source.entry_id),
    ['call', 'steer', 'result'],
  );
});
