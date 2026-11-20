import { nativeOwner } from './fixtures/native-owner.mjs';
import { message, text } from './fixtures/native-history.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ContextReadCache } from '../src/read/read-cache.mjs';
import { prepareContextRead } from '../src/read/context-read.mjs';
import { READ_SNAPSHOT_LIMIT } from '../src/read/read-snapshots.mjs';
import { navigationIndex, navigationRow } from '../src/read/read-navigation.mjs';
import { contextSelection, ALL_CONTENT } from '../src/read/read-schema.mjs';

import { jsonBytes } from '../src/mcp/response-budget.mjs';

import { buildSessionProjection, SessionManager } from './fixtures/pi.mjs';
import { assertInvalidArguments } from './fixtures/tool-call.mjs';

const identity = {
  session_id: 'fixture',
  file: '/fixture/session.jsonl',
  native_id: 'native',
  native_cwd: '/fixture',
};
const args = {
  session_id: 'fixture',
  range: { recent: -1 },
  content: ALL_CONTENT,
  max_bytes: 4096,
};
const textUnit = (entry, text, extra = {}) => ({
  type: 'text',
  source: { entry_id: entry, message_index: 0, block_index: 0 },
  block: { type: 'text', text },
  ...extra,
});
const snapshot = (units, extra = {}) => ({
  session_id: identity.session_id,
  view: 'session',
  leaf_id: 'leaf',
  selection: contextSelection(args),
  omissions: {},
  units,
  ...extra,
});
const rows = (snap, { query } = {}) => {
  const index = navigationIndex(snap, query);
  return index.order.map((offset) => navigationRow(index, offset, (i) => i, query));
};

test('codemode overview groups by canonical tool identity and surfaces nested failures despite long code', () => {
  const toolId = 'canonical-first';
  const children = [
    {
      id: 'one',
      name: 'read_file',
      arguments: { path: '/src/config.mjs' },
      status: 'success',
      result: 'config',
    },
    {
      id: 'two',
      name: 'run_tests',
      arguments: {},
      status: 'error',
      error: 'assertion: expected permission denied',
    },
    { id: 'three', name: 'write_file', arguments: {}, status: 'unfinished' },
  ];
  const snap = snapshot([
    {
      type: 'tool_call',
      tool_id: toolId,
      call_id: 'reused',
      block: {
        type: 'toolCall',
        name: 'codemode',
        arguments: { code: 'irrelevant();'.repeat(5000) },
      },
    },
    textUnit('steering', 'Please verify permissions'),
    {
      type: 'tool_result',
      tool_id: toolId,
      message: {
        role: 'toolResult',
        toolName: 'codemode',
        content: [{ type: 'text', text: 'Batch finished' }],
        nestedCalls: { calls: children },
      },
    },
    {
      type: 'tool_call',
      tool_id: 'canonical-second',
      call_id: 'reused',
      block: { type: 'toolCall', name: 'read_file', arguments: { path: '/another/file' } },
    },
  ]);
  const overview = rows(snap);
  assert.equal(overview.length, 3);
  const tool = overview[0];
  assert.equal(tool.type, 'tool');
  assert.match(tool.text, /3 operations/);
  assert.match(tool.text, /2 error\/unfinished/);
  assert.match(tool.text, /run_tests: error assertion: expected permission denied/);
  assert.ok(tool.related.some((link) => link.relation === 'operation'));
  assert.ok(tool.text.length < 900);
  assert.doesNotMatch(tool.text, /irrelevant/);
  assert.match(overview[2].text, /result not recorded/);
  assert.match(overview[2].text, /\/another\/file/);
  const hits = rows(snap, { query: 'permission denied' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'tool');
  assert.match(hits[0].text, /permission denied/);
});

test('native search matches adjacent assistant blocks and expands their complete source document', () => {
  const manager = SessionManager.inMemory('/synthetic');
  manager.appendMessage({ role: 'user', content: 'Review the change.', timestamp: 0 });
  const texts = [
    'Earlier detail. '.repeat(300) + 'First observation.',
    'Final recommendation.' + ' Supporting detail.'.repeat(300),
    'Additional conclusion outside the matching phrase.',
  ];
  const entry = manager.appendMessage({
    role: 'assistant',
    content: texts.map((text) => ({ type: 'text', text, textSignature: 'PRIVATE_SIGNATURE' })),
    timestamp: 0,
  });
  const data = { entries: manager.getEntries(), leafId: manager.getLeafId() };
  const request = { ...args, max_bytes: 65536 };
  const query = 'first observation.\nfinal recommendation.';
  const captured = prepareContextRead(
    data,
    { ...request, search_query: query },
    {
      buildSessionProjection,
    },
  );
  const cache = new ContextReadCache();
  const found = cache.navigate(captured, request, { identity }, query);
  assert.equal(found.matches, 1);
  assert.equal(found.items[0].type, 'assistant');
  assert.match(found.items[0].text, /First observation\.\nFinal recommendation\./);
  const expanded = cache.expand([found.items[0].ref], identity);
  for (const [index, text] of texts.entries()) {
    const parts = expanded.units.filter((unit) => unit.source.block_index === index);
    assert.ok(parts.every((unit) => unit.source.entry_id === entry));
    assert.equal(parts.map((unit) => unit.block?.text ?? '').join(''), text);
  }
  assert.doesNotMatch(JSON.stringify(expanded), /PRIVATE_SIGNATURE/);
});

test('native search does not join a phrase across messages or a different content kind', () => {
  const text = (value) => ({ type: 'text', text: value });
  for (const boundary of ['message', 'thinking', 'tool']) {
    const manager = SessionManager.inMemory('/synthetic');
    manager.appendMessage({ role: 'user', content: 'Review the change.', timestamp: 0 });
    const first = text('First observation.'),
      second = text('Final recommendation.');
    if (boundary === 'message') {
      manager.appendMessage({ role: 'assistant', content: [first], timestamp: 0 });
      manager.appendMessage({ role: 'assistant', content: [second], timestamp: 0 });
    } else {
      const middle =
        boundary === 'thinking'
          ? { type: 'thinking', thinking: 'Check the evidence.' }
          : { type: 'toolCall', id: 'check', name: 'read', arguments: { path: '/synthetic' } };
      manager.appendMessage({ role: 'assistant', content: [first, middle, second], timestamp: 0 });
    }
    const query = 'First observation.\nFinal recommendation.';
    const captured = prepareContextRead(
      { entries: manager.getEntries(), leafId: manager.getLeafId() },
      { ...args, search_query: query },
      { buildSessionProjection },
    );
    assert.equal(rows(captured, { query }).length, 0, boundary);
    const shared = 'ation.';
    const matches = prepareContextRead(
      { entries: manager.getEntries(), leafId: manager.getLeafId() },
      { ...args, search_query: shared },
      { buildSessionProjection },
    );
    assert.deepEqual(
      rows(matches, { query: shared }).map((row) => row.text),
      [first.text, second.text],
      boundary,
    );
  }
});

test('command output stays searchable and complete across changing page budgets', () => {
  const output = 'diagnostic 😃 "\\\r\n\u0018\uD800'.repeat(1900) + 'distinct final diagnostic';
  const entries = [
    {
      type: 'message',
      id: 'command',
      parentId: null,
      message: { role: 'bashExecution', command: 'generate-diagnostics', output, exitCode: 23 },
    },
  ];
  const request = { session_id: identity.session_id, content: ALL_CONTENT };
  const capture = prepareContextRead({ entries, leafId: 'command' }, request, {
    buildSessionProjection,
  });
  const cache = new ContextReadCache();
  const query = 'distinct final diagnostic';
  const found = cache.navigate(capture, request, { identity }, query);
  assert.equal(found.matches, 1);
  assert.match(found.items[0].text, /distinct final diagnostic/);
  const expanded = cache.expand([found.items[0].ref], identity);
  let page = cache.render(expanded, { max_bytes: 4096 }, { identity });
  const nextPage = (cursor) => {
    const next = { cursor, max_bytes: 8192 };
    const saved = cache.get(next, identity);
    return cache.render(saved.snapshot, next, { ...saved, identity });
  };
  const firstCursor = page.next_cursor;
  let secondPage;
  const parts = [];
  while (true) {
    for (const item of page.items)
      if (typeof item.message?.output === 'string') {
        assert.equal(item.message.exitCode, 23);
        parts.push(item.message.output);
      }
    if (!page.next_cursor) break;
    page = nextPage(page.next_cursor);
    secondPage ??= page;
  }
  assert.equal(parts.join(''), output);
  assert.deepEqual(nextPage(firstCursor), secondPage);
});

test('search filters before bounded capture and retains the complete matching logical tool pair', () => {
  const entries = [];
  const add = (id, role, content, fields) =>
    entries.push(message(id, entries.at(-1)?.id ?? null, role, content, fields));
  const tool = (id, args) => ({ type: 'toolCall', name: 'read', id, arguments: args });
  add('u', 'user', 'Inspect the verification run.');
  const noise = 'x'.repeat(50 * 1024);
  for (let i = 0; i < Math.ceil(READ_SNAPSHOT_LIMIT / (noise.length * 4)) + 3; i++)
    add('noise-' + i, 'assistant', [tool('noise-' + i, { code: noise })]);
  add('call', 'assistant', [tool('target', { path: '/target/evidence.txt' })]);
  add('result', 'toolResult', [text('needle-verification')], {
    toolCallId: 'target',
    nestedCalls: { calls: [{ id: 'child', name: 'verify_file', result: 'child-only-match' }] },
  });
  const prepare = (extra) =>
    prepareContextRead({ entries }, { ...args, ...extra }, { buildSessionProjection });
  assert.throws(() => prepare(), /READ_SNAPSHOT_TOO_LARGE/);
  for (const query of ['needle-verification', 'child-only-match']) {
    const found = prepare({ search_query: query });
    assert.deepEqual(
      found.units.map((unit) => unit.source.entry_id),
      ['call', 'result'],
    );
    assert.ok(jsonBytes(found) < 4096);
    const [hit] = rows(found, { query });
    assert.equal(hit.type, 'tool');
    assert.ok(hit.text.includes(query));
  }
});

test('reader tool items preserve their title, preview and searchable source text', () => {
  const snap = snapshot(
    [
      {
        type: 'tool',
        title: 'Tool receipt',
        text: 'Background context. '.repeat(100) + 'memory evidence',
        preview: 'Preview-only marker',
        source: { reader_item: 'memory' },
      },
    ],
    { view: 'adapted' },
  );
  assert.equal(rows(snap)[0].text, 'Preview-only marker');
  assert.equal(rows(snap, { query: 'receipt' })[0].title, 'Tool receipt');
  assert.equal(rows(snap, { query: 'preview-only' })[0].text, 'Preview-only marker');
  const [match] = rows(snap, { query: 'memory evidence' });
  assert.match(match.text, /memory evidence/);
  assert.equal(match.truncated, true);
});

async function bridgeFixture(t) {
  const f = await nativeOwner(t, {
    prefix: 'navigation',
    factory: () => assert.fail('Read must not start a writer'),
  });
  const { bridge } = f;
  const entries = [
    message('u', null, 'user', 'Find the permission decision'),
    message('a', 'u', 'assistant', [
      text('start '.repeat(500) + 'A unique middle decision' + ' end'.repeat(700)),
    ]),
    message('u2', 'a', 'user', 'Current task'),
    message('a2', 'u2', 'assistant', [text('Current progress')]),
  ];
  let acquisitions = 0;
  bridge.pool.forRead = async () => ({
    generation: 'fixture',
    read: async (args) => {
      acquisitions++;
      return prepareContextRead({ entries, leafId: 'a2' }, args, { buildSessionProjection });
    },
  });
  return { ...f, entries, acquisitions: () => acquisitions };
}

test('Bridge search finds older effective content, expands frozen evidence and rechecks current permission', async (t) => {
  const f = await bridgeFixture(t);
  await assertInvalidArguments(f.bridge, 'read', {
    session_id: f.id,
    search_query: 'unique middle decision',
  });
  assert.equal(f.acquisitions(), 0, 'internal predicates are rejected before source acquisition');
  const brief = await f.bridge.read({ session_id: f.id, range: { recent: 1 } });
  assert.doesNotMatch(JSON.stringify(brief.items), /unique middle decision/);
  const found = await f.bridge.search({ session_id: f.id, query: 'UNIQUE MIDDLE DECISION' });
  assert.equal(found.matches, 1);
  assert.equal(found.next_cursor, null);
  assert.match(found.items[0].text, /unique middle decision/);
  const refs = [found.items[0].ref];
  f.entries[1].message.content[0].text = 'SOURCE REPLACED';
  found.items[0].text = 'PUBLIC PAGE MUTATED';
  const expanded = await f.bridge.read({ refs });
  assert.match(JSON.stringify(expanded.items), /unique middle decision/);
  assert.doesNotMatch(JSON.stringify(expanded.items), /SOURCE REPLACED|PUBLIC PAGE MUTATED/);
  assert.equal(f.acquisitions(), 2);
  f.config.grants = [];
  await assert.rejects(f.bridge.read({ refs }), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.acquisitions(), 2);
});

test('Bridge reference expansion rejects a changed native cwd without reacquiring content', async (t) => {
  const f = await bridgeFixture(t);
  const page = await f.bridge.read({ session_id: f.id });
  const other = path.join(path.dirname(f.session.cwd), 'replacement');
  await fs.mkdir(other);
  f.config.grants.push({ folder: other, read: true });
  const lines = (await fs.readFile(f.session.file, 'utf8')).trimEnd().split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: other });
  await fs.writeFile(f.session.file, lines.join('\n') + '\n');
  await assert.rejects(f.bridge.read({ refs: [page.items[0].ref] }), /INVALID_READ_REFERENCE/);
  assert.equal(f.acquisitions(), 1);
});

test('Bridge reference expansion supports refs from multiple captures of the same session', async (t) => {
  const f = await bridgeFixture(t);
  const first = await f.bridge.read({ session_id: f.id, range: { recent: 1 } });
  const second = await f.bridge.search({ session_id: f.id, query: 'unique middle decision' });
  const expanded = await f.bridge.read({ refs: [first.items[0].ref, second.items[0].ref] });
  const text = JSON.stringify(expanded.items);
  assert.match(text, /unique middle decision/);
  assert.equal(expanded.presentation, 'source');
});
