import { message, text } from '../../test/fixtures/native-history.mjs';
import assert from 'node:assert/strict';

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import module, { createMagicContextReader } from './index.mjs';
import { captureSessionRead } from '../../src/session-readers.mjs';
import { ContextReadCache } from '../../src/read-cache.mjs';
import { prepareContextRead } from '../../src/context-read.mjs';
import { buildSessionProjection } from '../../test/fixtures/pi.mjs';

// Storage fields are based on MC 0.49.20; migration numbers are not a read contract.
// Only the tables and columns it queries are needed in these isolated fixtures.
const schema = `
  CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
  INSERT INTO schema_migrations VALUES(95);
  CREATE TABLE session_projects(session_id TEXT, harness TEXT, project_path TEXT, PRIMARY KEY(session_id,harness));
  CREATE TABLE session_meta(session_id TEXT PRIMARY KEY, harness TEXT, counter INTEGER, cached_m0_bytes BLOB);
  CREATE TABLE compartments(
    id INTEGER PRIMARY KEY, session_id TEXT, harness TEXT, sequence INTEGER,
    title TEXT, content TEXT, p1 TEXT, p2 TEXT, p3 TEXT, p4 TEXT,
    start_message_id TEXT, end_message_id TEXT, start_block_index INTEGER, end_block_index INTEGER,
    rebase_status TEXT DEFAULT 'ok', created_at INTEGER
  );
  CREATE TABLE memories(
    id INTEGER PRIMARY KEY, project_path TEXT, category TEXT, content TEXT, importance INTEGER,
    status TEXT, expires_at INTEGER, source_session_id TEXT, source_type TEXT,
    verification_status TEXT, updated_at INTEGER, superseded_by_memory_id INTEGER
  );
`;

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-magic-context-'));
  const cwd = path.join(directory, 'project');
  await fs.mkdir(cwd);
  const database = path.join(directory, 'context.db');
  const db = new DatabaseSync(database);
  db.exec(schema);
  const identity = `dir:${createHash('md5').update(cwd).digest('hex').slice(0, 12)}`;
  const context = {
    session: { id: 'ps_public', native_id: 'native-public', cwd },
    owner: { available: false, commands: [], tools: [] },
    request: {},
    nativeRead: async ({ entry_ids } = {}) => ({
      units: [],
      leaf_id: null,
      entry_relations: Object.fromEntries((entry_ids ?? []).map((id) => [id, 'unknown'])),
    }),
  };
  db.prepare('INSERT INTO session_projects VALUES(?,?,?)').run('native-public', 'pi', identity);
  t.after(async () => {
    db.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const insert = (table, row) =>
    db
      .prepare(
        `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row)
          .map(() => '?')
          .join(',')})`,
      )
      .run(...Object.values(row));
  const compartment = (overrides = {}) =>
    insert('compartments', {
      id: 1,
      session_id: 'native-public',
      harness: 'pi',
      sequence: 1,
      title: 'Design decision',
      content: 'Stored summary',
      p1: 'Detailed summary',
      p2: 'Brief with anchors',
      p3: 'Decision',
      p4: null,
      start_message_id: 'entry-start',
      end_message_id: 'entry-end',
      end_block_index: 2,
      rebase_status: 'ok',
      created_at: 1000,
      ...overrides,
    });
  const memory = (overrides = {}) =>
    insert('memories', {
      id: 1,
      project_path: identity,
      category: 'CONSTRAINTS',
      content: 'Public constraint',
      importance: 90,
      status: 'active',
      expires_at: null,
      source_session_id: 'origin-public',
      source_type: 'historian',
      verification_status: 'verified',
      updated_at: 1000,
      superseded_by_memory_id: null,
      ...overrides,
    });
  return { directory, database, db, cwd, identity, context, compartment, memory };
}

test('explicit database, supported schema, and lifecycle registration are required', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () => createMagicContextReader({ database: 'relative.db' }),
    /MAGIC_CONTEXT_INVALID_OPTIONS/,
  );
  const missing = path.join(f.directory, 'missing.db');
  assert.throws(
    () => createMagicContextReader({ database: missing }),
    /MAGIC_CONTEXT_DATABASE_UNAVAILABLE/,
  );
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  let registered, cleanup;
  module.start(
    {
      id: module.id,
      services: {
        sessionReaders: {
          register(id, reader) {
            registered = { id, reader };
            return () => {
              registered = null;
            };
          },
        },
      },
      onStop(value) {
        cleanup = value;
      },
    },
    { database: f.database },
  );
  assert.equal(registered.id, 'magic-context');
  assert.equal(typeof registered.reader.read, 'function');
  cleanup();
  assert.equal(registered, null);
  f.db.exec('ALTER TABLE compartments DROP COLUMN rebase_status');
  assert.throws(
    () => createMagicContextReader({ database: f.database }),
    /MAGIC_CONTEXT_SCHEMA_MISMATCH/,
  );
});

test('global project registration and foreign harness records do not activate a reader', async (t) => {
  const f = await fixture(t),
    reader = createMagicContextReader({ database: f.database });
  f.memory();
  assert.equal(
    await reader.matches(f.context),
    false,
    'session_projects may be background backfilled',
  );
  assert.equal(
    await reader.matches({
      ...f.context,
      session: { ...f.context.session, cwd: path.join(f.directory, 'removed-cwd') },
    }),
    false,
    'an unrelated backfilled session does not need its old cwd to exist',
  );
  f.compartment({ harness: 'opencode' });
  assert.equal(await reader.matches(f.context), false);
  assert.equal(
    await reader.matches({ ...f.context, session: { ...f.context.session, native_id: 'other' } }),
    false,
  );
  f.db.prepare('INSERT INTO session_meta VALUES(?,?,?,?)').run('native-public', 'pi', 0, null);
  assert.equal(await reader.matches(f.context), false);
  f.db.exec('UPDATE session_meta SET counter=1');
  assert.equal(await reader.matches(f.context), true);
  f.db.prepare('UPDATE session_projects SET project_path=?').run('dir:another-project');
  assert.equal(await reader.matches(f.context), false);
  await assert.rejects(reader.read(f.context), /MAGIC_CONTEXT_SESSION_MISMATCH/);
});

test('live registration is target-specific and still requires the matching project identity', async (t) => {
  const f = await fixture(t),
    reader = createMagicContextReader({ database: f.database });
  const owner = { available: true, commands: ['ctx-status', 'ctx-recomp'], tools: [] };
  assert.equal(await reader.matches({ ...f.context, owner }), true);
  assert.equal(
    await reader.matches({ ...f.context, owner: { ...owner, available: false } }),
    false,
  );
  assert.equal(
    await reader.matches({ ...f.context, owner: { ...owner, commands: ['ctx-status'] } }),
    false,
  );
  f.db.exec("UPDATE session_projects SET project_path='git:wrong'");
  assert.equal(await reader.matches({ ...f.context, owner }), false);
});

test('stored summaries use existing MC tiers and source relationships without database writes', async (t) => {
  const f = await fixture(t);
  f.compartment();
  f.compartment({ id: 2, sequence: 2, p2: '', p3: 'Second decision', rebase_status: 'unresolved' });
  f.compartment({
    id: 3,
    sequence: 3,
    p1: null,
    p2: null,
    p3: null,
    content: 'Existing flat summary',
    end_message_id: 'synth-user-abc',
  });
  f.compartment({ id: 4, sequence: 4, session_id: 'other-session', content: 'EXCLUDED_SESSION' });
  f.memory();
  f.memory({ id: 2, importance: 50, status: 'permanent', content: 'Permanent convention' });
  f.memory({ id: 3, status: 'archived', content: 'EXCLUDED_ARCHIVED' });
  f.memory({ id: 4, expires_at: 1, content: 'EXCLUDED_EXPIRED' });
  f.memory({ id: 5, superseded_by_memory_id: 1, content: 'EXCLUDED_SUPERSEDED' });
  f.memory({ id: 6, project_path: 'other-project', content: 'EXCLUDED_PROJECT' });
  const before = await fs.readFile(f.database);
  const reader = createMagicContextReader({ database: f.database });
  assert.equal(await reader.matches(f.context), true);
  const result = await reader.read({
    ...f.context,
    request: { content: { summary: -1, memory: -1 } },
  });
  assert.equal(result.native, true);
  assert.deepEqual(
    result.items.map((item) => item.id),
    ['compartment:1', 'compartment:2', 'compartment:3', 'memory:2', 'memory:1'],
  );
  assert.equal(result.items[0].text, 'Detailed summary');
  assert.equal(result.items[0].preview, 'Brief with anchors');
  assert.equal(result.items[0].source.source_entry_id, 'entry-end');
  assert.equal(result.items[0].source.source_relation, 'history_leaf');
  assert.equal(result.items[0].source.mc_end_block_index, 2);
  assert.equal(result.items[0].source.from_entry_id, undefined);
  assert.equal(
    result.items[0].source.end_block_index,
    undefined,
    'MC part coordinates are not native content indexes',
  );
  assert.equal(result.items[1].preview, 'Second decision');
  assert.equal(result.items[1].source.source_unavailable, 'unresolved_boundary');
  assert.equal(result.items[1].source.source_entry_id, undefined);
  assert.equal(result.items[2].text, 'Existing flat summary');
  assert.equal(result.items[2].source.source_unavailable, 'no_native_history_leaf');
  assert.equal(result.items[3].source.scope, 'own_project');
  assert.equal(result.items[3].source.origin_session_id, 'origin-public');
  assert.equal(
    result.items[3].source.source_entry_id,
    undefined,
    'a memory origin is not exact evidence',
  );
  assert.ok(!JSON.stringify(result).includes('EXCLUDED'));
  assert.deepEqual(result.coverage, [
    { type: 'summary', selected: 3, total: 3 },
    { type: 'memory', selected: 2, total: 2 },
  ]);
  assert.deepEqual(await fs.readFile(f.database), before);
  assert.deepEqual(await fs.readdir(f.directory), ['context.db', 'project']);
  await assert.rejects(
    reader.read({ ...f.context, request: { leaf_id: null } }),
    /MAGIC_CONTEXT_EXPLICIT_LEAF_UNSUPPORTED/,
  );
});

test('default MC reads exclude known other-branch summaries before limiting, while unlimited summaries retain their sources', async (t) => {
  const f = await fixture(t);
  const entries = [
    message('root', null, 'user', 'Choose storage'),
    message('common', 'root', 'assistant', [text('Common design')]),
    message('current-input', 'common', 'user', 'Use PostgreSQL'),
    message('current-answer', 'current-input', 'assistant', [text('PostgreSQL selected')]),
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'current-answer',
      firstKeptEntryId: 'current-input',
      summary: 'Shared constraints',
      tokensBefore: 2000,
    },
    message('latest-answer', 'compact', 'assistant', [text('Implementing PostgreSQL')]),
    message('old-input', 'common', 'user', 'Use MongoDB'),
    message('old-answer', 'old-input', 'assistant', [text('MongoDB is selected')]),
  ];
  for (const [id, end, status] of [
    [1, 'common', 'ok'],
    [2, 'current-answer', 'ok'],
    [3, 'missing', 'ok'],
    [4, 'old-answer', 'unresolved'],
    [5, 'old-input', 'ok'],
    [6, 'old-answer', 'ok'],
  ])
    f.compartment({
      id,
      sequence: id,
      end_message_id: end,
      rebase_status: status,
      ...(id === 6 ? { p1: 'MongoDB is selected' } : {}),
    });
  f.memory({ source_session_id: 'other-branch-origin' });
  const reader = { id: module.id, ...createMagicContextReader({ database: f.database }) };
  const capture = async (summary) => {
    const request = { session_id: f.context.session.id, content: { summary } };
    const nativeRead = (options) =>
      prepareContextRead(
        { entries, leafId: 'latest-answer' },
        { ...request, ...options },
        { buildSessionProjection },
      );
    return captureSessionRead(reader, { ...f.context, request, nativeRead }, request);
  };
  const recent = await capture(4);
  const summaries = recent.units.filter((item) =>
    item.source.reader_item?.startsWith('compartment:'),
  );
  assert.deepEqual(
    summaries.map((item) => item.branch_relation),
    ['on_branch', 'on_branch', 'unknown', 'unknown'],
  );
  assert.deepEqual(recent.reader.coverage[0], {
    type: 'summary',
    selected: 4,
    total: 6,
    excluded: 2,
  });
  const full = await capture(-1);
  const cache = new ContextReadCache();
  const found = cache.navigate(
    full,
    { session_id: f.context.session.id, content: { summary: -1, memory: -1 }, max_bytes: 4096 },
    { identity: f.context.session },
    'MongoDB',
  );
  assert.equal(found.items[0].branch_relation, 'off_branch');
  assert.match(
    JSON.stringify(cache.expand([found.items[0].ref], f.context.session).units),
    /MongoDB/,
  );
  const source = found.items[0].related.find((link) => link.relation === 'source_context');
  const sourceRequest = cache.reference(source.ref).document.request;
  assert.equal(sourceRequest.leaf_id, 'old-answer');
  assert.equal(sourceRequest.view, 'session');
  assert.match(
    JSON.stringify(
      prepareContextRead({ entries }, sourceRequest, { buildSessionProjection }).units,
    ),
    /MongoDB/,
  );
});

test('read-only connections see committed live WAL data and detach each result', async (t) => {
  const f = await fixture(t);
  f.db.exec('PRAGMA journal_mode=WAL');
  f.compartment();
  f.memory();
  const reader = createMagicContextReader({ database: f.database });
  const first = await reader.read(f.context);
  assert.equal(first.items.find((item) => item.id === 'memory:1').text, 'Public constraint');
  f.db
    .prepare('UPDATE memories SET content=?, updated_at=? WHERE id=1')
    .run('Changed by live writer', 2000);
  const second = await reader.read(f.context);
  assert.equal(second.items.find((item) => item.id === 'memory:1').text, 'Changed by live writer');
  assert.equal(first.items.find((item) => item.id === 'memory:1').text, 'Public constraint');
  assert.equal(
    f.db.prepare('SELECT content FROM memories WHERE id=1').get().content,
    'Changed by live writer',
  );
});

test('unrelated migrations preserve content while changed consumed representations reject', async (t) => {
  const f = await fixture(t);
  f.compartment();
  f.memory();
  const reader = createMagicContextReader({ database: f.database });
  const content = async () =>
    (await reader.read(f.context)).items.map(({ source: { captured_at, ...source }, ...item }) => ({
      ...item,
      source,
    }));
  const before = await content();
  f.db.exec('UPDATE schema_migrations SET version=96; CREATE TABLE unrelated_feature(value TEXT)');
  assert.deepEqual(await content(), before);
  f.db.exec("UPDATE memories SET expires_at='2027-01-01T00:00:00Z'");
  await assert.rejects(reader.read(f.context), /MAGIC_CONTEXT_SCHEMA_MISMATCH/);
  f.db.exec("UPDATE memories SET expires_at=NULL; UPDATE compartments SET p1=x'0102'");
  await assert.rejects(reader.read(f.context), /MAGIC_CONTEXT_SCHEMA_MISMATCH/);
});
