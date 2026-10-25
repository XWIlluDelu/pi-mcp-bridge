import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { ContextReadCache } from '../src/read-cache.mjs';
import { prepareContextRead } from './fixtures/read-pages.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-read-cache-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd, { mode: 0o700 });
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: { ...denyAllPermissions(), read: true, send: true },
  };
  const bridge = await new Bridge(config, () => assert.fail('No writer')).init();
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  const entries = [
    {
      type: 'message',
      id: 'u',
      parentId: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'task' },
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50000) },
        ],
      },
    },
    {
      type: 'message',
      id: 'a',
      parentId: 'u',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: Array.from(
              { length: 50 },
              (_, i) => 'line-' + i + ' x'.repeat(400) + '\n\n',
            ).join(''),
          },
        ],
      },
    },
  ];
  let acquisitions = 0;
  bridge.pool.forRead = async () => ({
    generation: 'fixture',
    read: async (args) => {
      acquisitions++;
      return prepareContextRead({ entries, leafId: 'a' }, args);
    },
  });
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    bridge,
    config,
    entries,
    session,
    id: made.session_id,
    acquisitions: () => acquisitions,
  };
}

async function sourcePage(f, args = {}) {
  const overview = await f.bridge.read({ session_id: f.id, ...args });
  const ref = overview.items.find((item) => item.type === 'assistant').ref;
  return f.bridge.read({ refs: [ref], max_bytes: 4096 });
}

test('frozen source pages store clean content and reauthorize without reacquiring native entries', async (t) => {
  const f = await fixture(t),
    first = await sourcePage(f);
  assert.ok(first.next_cursor);
  for (const stored of f.bridge.readCache.entries.values()) {
    assert.ok(!JSON.stringify(stored).includes('AAAAAAA'));
    assert.equal(stored.snapshot.entries, undefined);
    assert.equal(stored.snapshot.encodedRecords, undefined);
  }
  t.mock.method(Date, 'now', () => 10 ** 15);
  f.entries[1].message.content[0].text = 'CHANGED';
  first.items.find((item) => item.block?.text).block.text = 'MUTATED_PUBLIC_PAGE';
  const next = await f.bridge.read({ cursor: first.next_cursor });
  assert.ok(!JSON.stringify(next).includes('CHANGED'));
  assert.ok(!JSON.stringify(next).includes('MUTATED_PUBLIC_PAGE'));
  assert.equal(f.acquisitions(), 1);
  f.config.defaults.read = false;
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.acquisitions(), 1);
});

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

test('native cwd replacement invalidates a frozen cursor under the same native ID', async (t) => {
  const f = await fixture(t),
    first = await sourcePage(f);
  const text = await fs.readFile(f.session.file, 'utf8'),
    lines = text.trimEnd().split('\n'),
    header = JSON.parse(lines[0]);
  const other = path.join(path.dirname(f.session.cwd), 'other-project');
  await fs.mkdir(other);
  header.cwd = other;
  lines[0] = JSON.stringify(header);
  await fs.writeFile(f.session.file, lines.join('\n') + '\n');
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /STALE_CURSOR/);
  assert.equal(f.acquisitions(), 1);
});

test('adapted reference pages preserve both turn range and independent memory scope', async (t) => {
  const f = await fixture(t);
  for (const native of [false, true]) {
    const unregister = f.bridge.compatibilityServices.sessionReaders.register('scope-fixture', {
      matches: () => true,
      read: ({ request }) => ({
        native,
        items: [
          { id: 'memory', kind: 'memory', text: 'Stored memory details.\n\n'.repeat(600) },
          ...(request.content?.memory === 2
            ? [{ id: 'earlier', kind: 'memory', text: 'Earlier memory.' }]
            : []),
        ],
      }),
    });
    try {
      const scope = { range: { recent: 1 }, content: { memory: 1 } };
      const overview = await f.bridge.read({ session_id: f.id, ...scope });
      const wider = await f.bridge.read({ session_id: f.id, ...scope, content: { memory: 2 } });
      assert.equal(overview.items.filter((item) => item.type === 'memory').length, 1);
      assert.equal(wider.items.filter((item) => item.type === 'memory').length, 2);
      const expanded = await f.bridge.read({
        refs: [overview.items.find((item) => item.type === 'memory').ref],
        max_bytes: 4096,
      });
      assert.ok(expanded.next_cursor);
      assert.deepEqual(expanded.selection, overview.selection);
      const inherited = await f.bridge.read({ cursor: expanded.next_cursor });
      const explicit = await f.bridge.read({ cursor: expanded.next_cursor, ...scope });
      assert.deepEqual(explicit.items, inherited.items);
      for (const patch of [{ range: { recent: 3 } }, { content: { memory: 2 } }])
        await assert.rejects(
          f.bridge.read({ cursor: expanded.next_cursor, ...patch }),
          /STALE_CURSOR/,
        );
    } finally {
      unregister();
    }
  }
});

test('batched references preserve source order across a steering boundary and a paired result', async (t) => {
  const f = await fixture(t);
  const message = (id, parentId, role, content, extra = {}) => ({
    type: 'message',
    id,
    parentId,
    message: { role, content, ...extra },
  });
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
