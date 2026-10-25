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

test('frozen cache stores only detached clean units and never reacquires changed native entries', async (t) => {
  const f = await fixture(t),
    first = await f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 });
  assert.ok(first.next_cursor);
  const stored = [...f.bridge.readCache.entries.values()][0];
  assert.ok(!JSON.stringify(stored).includes('AAAAAAA'));
  assert.equal(stored.snapshot.entries, undefined);
  assert.equal(stored.snapshot.encodedRecords, undefined);
  t.mock.method(Date, 'now', () => 10 ** 15);
  f.entries[1].message.content[0].text = 'CHANGED';
  first.items[0].block.text = 'MUTATED_PUBLIC_PAGE';
  const next = await f.bridge.read({ cursor: first.next_cursor });
  assert.ok(!JSON.stringify(next).includes('CHANGED'));
  assert.ok(!JSON.stringify(next).includes('MUTATED_PUBLIC_PAGE'));
  assert.equal(f.acquisitions(), 1);
  f.config.defaults.read = false;
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.acquisitions(), 1);
});

test('eviction and a new Bridge return STALE_CURSOR without reconstructing old snapshots', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxEntries: 1 });
  const first = await f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 });
  await f.bridge.read({
    session_id: f.id,
    detail: 'full',
    max_bytes: 4096,
    select: { thinking: 0 },
  });
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /STALE_CURSOR/);
  const fresh = await f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 });
  await f.bridge.close();
  const restarted = await new Bridge(f.config, () => assert.fail('No writer')).init();
  try {
    await assert.rejects(restarted.read({ cursor: fresh.next_cursor }), /STALE_CURSOR/);
  } finally {
    await restarted.close();
  }
});

test('snapshot admission failure never issues an unusable cursor or silently narrows selectors', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxBytes: 4096 });
  await assert.rejects(
    f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 }),
    /READ_SNAPSHOT_TOO_LARGE/,
  );
  assert.equal(f.bridge.readCache.entries.size, 0);
  assert.equal(f.bridge.readCache.accountedBytes, 0);
  const denied = await callBridgeTool(f.bridge, 'read', {
    session_id: f.id,
    detail: 'full',
    max_bytes: 4096,
  });
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'READ_SNAPSHOT_TOO_LARGE');
  f.bridge.readCache = new ContextReadCache();
  f.entries[1].message.content[0].text = ('x'.repeat(1000) + '\n\n').repeat(9000);
  await assert.rejects(
    f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 }),
    /READ_SNAPSHOT_TOO_LARGE/,
  );
  assert.equal(f.bridge.readCache.entries.size, 0);
  assert.ok(f.bridge.readCache.accountedBytes <= f.bridge.readCache.maxBytes);
});

test('batch cursor snapshots are pinned until assembly and temporary cache pressure refuses another read honestly', async (t) => {
  const f = await fixture(t);
  f.bridge.readCache = new ContextReadCache({ maxEntries: 1 });
  const response = await callBridgeTool(f.bridge, 'batch', {
    operations: [
      { op: 'read', args: { session_id: f.id, detail: 'full', max_bytes: 4096 } },
      { op: 'read', args: { session_id: f.id, detail: 'full', max_bytes: 4096 } },
    ],
  });
  const [first, second] = response.structuredContent.results;
  assert.ok(first.result.next_cursor);
  assert.equal(second.error.code, 'READ_CACHE_BUSY');
  const next = await f.bridge.read({ cursor: first.result.next_cursor });
  assert.equal(next.leaf_id, first.result.leaf_id);
  assert.equal([...f.bridge.readCache.entries.values()][0].pins, 0);
});

test('cursor overrides validate explicit values only, and canonical native identity remains authoritative', async (t) => {
  const f = await fixture(t),
    first = await f.bridge.read({
      session_id: f.id,
      detail: 'full',
      max_bytes: 4096,
      preset: 'full',
      select: { text: 1, tools: 0, thinking: 0, commands: 0 },
    });
  assert.ok(first.next_cursor);
  const next = await f.bridge.read({
    cursor: first.next_cursor,
    select: { tools: 0 },
    max_bytes: 8192,
  });
  assert.deepEqual(next.selection, first.selection);
  for (const patch of [{ select: { tools: -1 } }, { preset: 'full' }, { leaf_id: null }])
    await assert.rejects(f.bridge.read({ cursor: first.next_cursor, ...patch }), /STALE_CURSOR/);
  await fs.writeFile(
    f.session.file,
    JSON.stringify({ ...f.session.header, id: 'different-native-id' }) + '\n',
  );
  await assert.rejects(f.bridge.read({ cursor: first.next_cursor }), /NOT_FOUND_OR_DENIED/);
});

test('native cwd replacement invalidates frozen cursors even under the same native ID', async (t) => {
  const f = await fixture(t),
    first = await f.bridge.read({ session_id: f.id, detail: 'full', max_bytes: 4096 });
  assert.ok(first.next_cursor);
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

test('expanded adapted references retain their original scope for cursor validation', async (t) => {
  const f = await fixture(t);
  for (const native of [false, true]) {
    const unregister = f.bridge.compatibilityServices.sessionReaders.register('scope-fixture', {
      matches: () => true,
      read: () => ({
        native,
        items: [{ id: 'memory', kind: 'memory', text: 'Stored memory details.\n\n'.repeat(600) }],
      }),
    });
    try {
      for (const scope of [{ preset: 'recent' }, { preset: 'full', select: { tools: 0 } }]) {
        const overview = await f.bridge.read({ session_id: f.id, ...scope });
        const ref = overview.items.find((item) => item.type === 'memory').ref;
        const expanded = await f.bridge.read({ refs: [ref], max_bytes: 4096 });
        assert.ok(expanded.next_cursor);
        assert.equal(expanded.detail, 'full');
        assert.deepEqual(expanded.selection, overview.selection);
        if (!native) assert.equal(expanded.selection, null);
        const next = await f.bridge.read({ cursor: expanded.next_cursor });
        const explicit = await f.bridge.read({
          cursor: expanded.next_cursor,
          ...scope,
          detail: 'full',
        });
        assert.deepEqual(explicit.items, next.items);
        await assert.rejects(
          f.bridge.read({ cursor: expanded.next_cursor, preset: 'latest' }),
          /STALE_CURSOR/,
        );
        await assert.rejects(
          f.bridge.read({ cursor: expanded.next_cursor, select: { recent_prompts: 1 } }),
          /STALE_CURSOR/,
        );
      }
    } finally {
      unregister();
    }
  }
});

test('adapted cursors preserve reader preset independently of equivalent native selectors', async (t) => {
  const f = await fixture(t);
  const unregister = f.bridge.compatibilityServices.sessionReaders.register('scoped-memory', {
    matches: () => true,
    read: ({ request }) => ({
      native: true,
      items: [
        { id: 'latest-memory', kind: 'memory', text: 'Current memory details.\n\n'.repeat(600) },
        ...(request.preset === 'recent'
          ? [{ id: 'earlier-memory', kind: 'memory', text: 'Earlier memory evidence.' }]
          : []),
      ],
    }),
  });
  t.after(unregister);
  const latest = await f.bridge.read({ session_id: f.id });
  const recent = await f.bridge.read({
    session_id: f.id,
    preset: 'recent',
    select: { recent_prompts: 1 },
  });
  assert.equal(latest.items.filter((item) => item.type === 'memory').length, 1);
  assert.equal(recent.items.filter((item) => item.type === 'memory').length, 2);
  assert.deepEqual(latest.selection, recent.selection);
  const expanded = await f.bridge.read({
    refs: [latest.items.find((item) => item.type === 'memory').ref],
    max_bytes: 4096,
  });
  assert.ok(expanded.next_cursor);
  const inherited = await f.bridge.read({ cursor: expanded.next_cursor });
  const same = await f.bridge.read({ cursor: expanded.next_cursor, preset: 'latest' });
  assert.deepEqual(same.items, inherited.items);
  await assert.rejects(
    f.bridge.read({
      cursor: expanded.next_cursor,
      preset: 'recent',
      select: { recent_prompts: 1 },
    }),
    /STALE_CURSOR/,
  );
});
