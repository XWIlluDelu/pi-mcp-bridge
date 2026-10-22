import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { prepareSession } from '../src/create-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import {
  SessionManager,
  parseSessionEntries,
  migrateSessionEntries,
} from '@earendil-works/pi-coding-agent';
import { loadSession, loadSavedSession, readSessionIdentity } from '../src/data.mjs';

for (const version of [1, 2, 3])
  test(`native v${version} history and a torn final record are read without changing any bytes`, async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-history-');
    await fs.mkdir(dir + '/sessions', { mode: 0o700 });
    const file = dir + '/sessions/history.jsonl',
      rows = [
        { type: 'session', id: 'native-history', cwd: dir, ...(version === 1 ? {} : { version }) },
        {
          type: 'message',
          ...(version === 1 ? {} : { id: 'u', parentId: null }),
          message: { role: 'user', content: 'USER' },
        },
        {
          type: 'message',
          ...(version === 1 ? {} : { id: 'c', parentId: 'u' }),
          message: {
            role: version < 3 ? 'hookMessage' : 'custom',
            customType: 'native-note',
            content: 'NOTE',
            display: false,
          },
        },
      ],
      bytes = rows.map(JSON.stringify).join('\n') + '\n{"type":"message","id":"torn';
    await fs.writeFile(file, bytes);
    const bridge = await new Bridge({
      stateDir: dir + '/state',
      attachmentDir: dir + '/ipc',
      sessionRoots: [dir + '/sessions'],
      folders: [{ path: dir }],
      defaults: { ...denyAllPermissions(), list: true, read: true },
    }).init();
    t.after(async () => {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const listed = await bridge.list();
    assert.equal(listed.sessions.length, 1);
    const read = await bridge.read({ session_id: listed.sessions[0].session_id, preset: 'full' });
    assert.ok(JSON.stringify(read).includes('USER'));
    assert.ok(JSON.stringify(read).includes('NOTE'));
    assert.deepEqual(read.history, { skipped_malformed_lines: 1, unterminated_tail: true });
    const native = parseSessionEntries(bytes);
    migrateSessionEntries(native);
    const loaded = await loadSession(file);
    assert.equal(loaded.entries.length, native.length - 1);
    assert.equal(loaded.entries[1].message.role, 'custom');
    assert.equal(await fs.readFile(file, 'utf8'), bytes);
    const identity = await readSessionIdentity(file);
    await fs.writeFile(file, JSON.stringify({ ...rows[0], id: 'replacement' }) + '\n');
    await assert.rejects(loadSavedSession(identity), /RUNTIME_SESSION_CHANGED/);
  });

test('native missing/empty cwd survives v1/v2/v3 reads without inferred project grants, writes or execution', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-cwd-')),
    root = path.join(dir, 'sessions');
  await fs.mkdir(root, { mode: 0o700 });
  const bridge = await new Bridge(
    {
      stateDir: path.join(dir, 'state'),
      sessionRoots: [root],
      folders: [],
      defaults: { ...denyAllPermissions(), list: true, read: true, send: true },
    },
    () => assert.fail('No writer for missing cwd'),
  ).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const version of [1, 2, 3])
    for (const cwd of [undefined, '']) {
      const nativeId = 'no-cwd-' + version + '-' + (cwd === undefined ? 'missing' : 'empty'),
        file = path.join(root, nativeId + '.jsonl');
      const header = {
        type: 'session',
        version,
        id: nativeId,
        timestamp: '2026-01-01T00:00:00Z',
        ...(cwd === undefined ? {} : { cwd }),
      };
      const bytes = Buffer.from(
        [
          header,
          {
            type: 'message',
            id: 'u',
            parentId: null,
            message: { role: 'user', content: 'NATIVE_NO_CWD', timestamp: 0 },
          },
        ]
          .map(JSON.stringify)
          .join('\n') + '\n',
      );
      await fs.writeFile(file, bytes);
      const identity = await readSessionIdentity(file);
      assert.equal(identity.cwd, null);
      const args = { session_id: identity.id, preset: 'full' };
      assert.ok(JSON.stringify(await bridge.read(args)).includes('NATIVE_NO_CWD'));
      assert.equal((await bridge.list({ session_id: identity.id })).sessions[0].project, null);
      assert.equal(
        (await bridge.send({ session_id: identity.id, text: 'NEVER' })).reason,
        'EXECUTION_CWD_UNAVAILABLE',
      );
      bridge.config.defaults = { ...denyAllPermissions() };
      bridge.config.grants = [{ folder: dir, read: true, list: true }];
      await assert.rejects(bridge.read(args), /NOT_FOUND_OR_DENIED/);
      bridge.config.grants = [{ session_id: identity.id, read: true, list: true }];
      assert.ok(JSON.stringify(await bridge.read(args)).includes('NATIVE_NO_CWD'));
      assert.deepEqual(await fs.readFile(file), bytes);
      bridge.config.defaults = { ...denyAllPermissions(), list: true, read: true, send: true };
      bridge.config.grants = [];
    }
});

test('discarded broken branches do not block native current context; traversed cycles and duplicate IDs reject', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-history-branch-');
  await fs.mkdir(dir + '/sessions', { mode: 0o700 });
  const file = dir + '/sessions/history.jsonl';
  const message = (id, parentId, role, text) => ({
    type: 'message',
    id,
    parentId,
    message: {
      role,
      content: role === 'assistant' ? [{ type: 'text', text }] : text,
      timestamp: 0,
    },
  });
  const rows = [
    { type: 'session', version: 3, id: 'partial-tree', cwd: dir },
    message('root', null, 'user', 'ROOT'),
    message('discarded', 'missing', 'assistant', 'DISCARDED'),
    message('cycle-a', 'cycle-b', 'user', 'CYCLE_A'),
    message('cycle-b', 'cycle-a', 'assistant', 'CYCLE_B'),
    message('current', 'root', 'user', 'CURRENT'),
    message('answer', 'current', 'assistant', 'ANSWER'),
  ];
  const bytes = rows.map(JSON.stringify).join('\n') + '\n{"torn":\n';
  await fs.writeFile(file, bytes);
  const bridge = await new Bridge({
    stateDir: dir + '/state',
    sessionRoots: [dir + '/sessions'],
    folders: [],
    defaults: { ...denyAllPermissions(), read: true },
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const native = SessionManager.open(file); // Use only an already LF-terminated v3 file.
  assert.deepEqual(
    native.getBranch().map((e) => e.id),
    ['root', 'current', 'answer'],
  );
  const id = (await readSessionIdentity(file)).id;
  const read = await bridge.read({ session_id: id, preset: 'full' });
  assert.ok(JSON.stringify(read.items).includes('CURRENT'));
  assert.ok(JSON.stringify(read.items).includes('ANSWER'));
  assert.ok(!JSON.stringify(read.items).includes('DISCARDED'));
  assert.equal(read.history.skipped_malformed_lines, 1);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  await assert.rejects(
    bridge.read({ session_id: id, leaf_id: 'cycle-a', preset: 'full' }),
    /INVALID_SESSION_TREE/,
  );
  await fs.writeFile(file, rows.concat(rows.at(-1)).map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(loadSession(file), /INVALID_SESSION_TREE/);
  const cyclic = structuredClone(rows);
  cyclic.at(-1).parentId = 'answer';
  await fs.writeFile(file, cyclic.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(loadSession(file), /INVALID_SESSION_TREE/);
});

test('fork resolves current bookmarks outside ancestry and reconnects labels/compaction in memory', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-fork-label-'),
    project = dir + '/project',
    root = dir + '/sessions';
  await fs.mkdir(project);
  await fs.mkdir(root);
  const config = {
    ...isolatedRuntime(dir),
    stateDir: dir + '/state',
    sessionRoots: [root],
    folders: [{ path: project }],
    defaults: { ...denyAllPermissions(), create: true, read: true },
  };
  let child;
  const bridge = await new Bridge(config, async (saved) => ({
    alive: true,
    stop: async () => {},
    command: async () => {
      child = SessionManager.open(saved.file);
      return { disposition: 'started' };
    },
  })).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const label of ['CURRENT_BOOKMARK', undefined]) {
    const parent = SessionManager.create(project, root);
    const user = parent.appendMessage({ role: 'user', content: 'PARENT_PROMPT', timestamp: 0 });
    const oldLabel = parent.appendLabelChange(user, 'OLD_BOOKMARK');
    const answer = parent.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ANSWER' }],
      timestamp: 0,
    });
    parent.branch(user);
    parent.appendLabelChange(user, label);
    parent.branch(answer);
    parent.appendCompaction('SUMMARY', oldLabel, 100);
    const bytes = await fs.readFile(parent.getSessionFile()),
      leaf = parent.getLeafId();
    const source = await readSessionIdentity(parent.getSessionFile());
    const result = await bridge.create({ fork_from: source.id, project, text: 'FORK_PROMPT' });
    assert.equal(result.status, 'started', JSON.stringify(result));
    assert.equal(child.getLabel(user), label);
    assert.ok(!child.getEntries().some((e) => e.type === 'label' && e.label === 'OLD_BOOKMARK'));
    assert.equal(child.getEntries().find((e) => e.type === 'compaction').firstKeptEntryId, answer);
    const entries = child.getEntries();
    assert.ok(entries.every((e, i) => e.parentId === (entries[i - 1]?.id ?? null)));
    assert.equal(child.getHeader().cwd, project);
    assert.notEqual(child.getHeader().id, source.header.id);
    assert.equal(parent.getLeafId(), leaf);
    assert.deepEqual(await fs.readFile(parent.getSessionFile()), bytes);
  }
});

test('fork preserves v1/v2/v3 native ancestry and compaction references without cwd, double migration or source writes', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-history-fork-'),
    root = path.join(dir, 'sessions'),
    project = path.join(dir, 'project');
  await fs.mkdir(root, { mode: 0o700 });
  await fs.mkdir(project);
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [root],
    folders: [{ path: project }],
    piArgs: ['--session-dir', root],
    defaults: { ...denyAllPermissions(), read: true, create: true },
  };
  const received = [];
  const bridge = await new Bridge(config, async (saved) => ({
    alive: true,
    stop: async () => {},
    command: async () => {
      received.push(SessionManager.open(saved.file).getEntries());
      return { disposition: 'started' };
    },
  })).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  for (const version of [1, 2, 3]) {
    const file = path.join(root, 'source-' + version + '.jsonl');
    const rows = [
      { type: 'session', version, id: 'native-fork-' + version, cwd: '' },
      {
        type: 'message',
        id: 'u',
        parentId: null,
        message: { role: 'user', content: 'FORK_SOURCE_USER', timestamp: 0 },
      },
      {
        type: 'message',
        id: 'a',
        parentId: 'u',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'FORK_SOURCE_ASSISTANT' }],
          timestamp: 0,
        },
      },
      {
        type: 'compaction',
        id: 'c',
        parentId: 'a',
        summary: 'FORK_SUMMARY',
        tokensBefore: 100,
        ...(version === 1 ? { firstKeptEntryIndex: 2 } : { firstKeptEntryId: 'a' }),
      },
    ];
    if (version === 1)
      for (const entry of rows.slice(1)) {
        delete entry.id;
        delete entry.parentId;
      }
    const bytes = Buffer.from(rows.map(JSON.stringify).join('\n') + '\n');
    await fs.writeFile(file, bytes);
    const source = await readSessionIdentity(file);
    assert.ok(
      JSON.stringify(await bridge.read({ session_id: source.id, preset: 'full' })).includes(
        'FORK_SOURCE_ASSISTANT',
      ),
    );
    const result = await bridge.create({ fork_from: source.id, project, text: 'FORK_TARGET' });
    assert.equal(result.status, 'started', JSON.stringify(result));
    const entries = received.at(-1);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].message.content, 'FORK_SOURCE_USER');
    assert.equal(entries[1].message.content[0].text, 'FORK_SOURCE_ASSISTANT');
    assert.equal(entries[2].firstKeptEntryId, entries[1].id);
    assert.equal((await bridge.session(result.session_id)).header.cwd, project);
    assert.deepEqual(await fs.readFile(file), bytes);
    const normalized = await loadSavedSession(source);
    const liveSnapshot = { entries: normalized.entries, leafId: normalized.leafId };
    const fallback = await prepareSession(config, project, {
      parent: source,
      snapshot: liveSnapshot,
    });
    assert.equal(fallback.entries[2].firstKeptEntryId, normalized.entries[1].id);
    const files = await fs.readdir(root);
    await assert.rejects(
      prepareSession(config, project, {
        parent: source,
        snapshot: { ...normalized, leafId: 'missing' },
      }),
      /INVALID_RUNTIME_ENTRIES/,
    );
    assert.deepEqual(await fs.readdir(root), files);
    assert.deepEqual(
      (
        await prepareSession(config, project, {
          parent: source,
          snapshot: { ...normalized, leafId: null },
        })
      ).entries,
      [],
    );
  }
});
