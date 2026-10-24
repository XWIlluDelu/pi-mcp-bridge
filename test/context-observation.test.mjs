import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextObservation,
  RetainedObservations,
  checkObservation,
} from '../src/context-observation.mjs';
import { ContextReadCache } from '../src/read-cache.mjs';
import { readSchema } from '../src/read-schema.mjs';
import { assertReadSnapshot } from '../src/context-read.mjs';

const args = { session_id: 'ps_observed', view: 'runtime' };
function fixture() {
  const data = {
    file: '/private/a.jsonl',
    id: 'native-a',
    leaf: 'u',
    entries: [{ id: 'u', parentId: null }],
  };
  const ctx = {
    sessionManager: {
      getSessionFile: () => data.file,
      getSessionId: () => data.id,
      getLeafId: () => data.leaf,
      getEntries: () => data.entries,
    },
  };
  return { data, ctx, observer: new ContextObservation('generation') };
}
const text = (text) => ({ type: 'text', text });

test('observations are detached request-stage data with honest identity, updates and branch/session invalidation', () => {
  const { data, ctx, observer } = fixture();
  const empty = assertReadSnapshot(observer.read(args, ctx), args);
  assert.equal(empty.observation.reason, 'no_observation');
  assert.equal(empty.observation.current_leaf_id, 'u');
  const messages = [
    { role: 'user', content: 'INPUT' },
    { role: 'system', content: '', sections: { memory: 'REQUEST_STAGE_MEMORY' } },
    {
      role: 'assistant',
      content: [text('BODY'), { type: 'image', mimeType: 'image/png', data: 'BASE64' }],
      responseId: 'SECRET',
    },
  ];
  observer.capture({ messages }, ctx);
  messages[0].content = 'MUTATED';
  data.entries.push({ id: 'a', parentId: 'u' });
  data.leaf = 'a';
  const first = assertReadSnapshot(observer.read(args, ctx), args);
  assert.equal(first.leaf_id, 'u');
  assert.equal(first.observation.phase, 'context_with_system_observer');
  assert.equal(first.observation.later_committed_entries, 1);
  assert.equal(first.observation.current_leaf_id, 'a');
  assert.ok(!JSON.stringify(first).includes('SECRET'));
  assert.ok(!JSON.stringify(first).includes('BASE64'));
  assert.equal(first.units[0].message.content, 'INPUT');
  assert.deepEqual(first.units[1].message.sections, { memory: 'REQUEST_STAGE_MEMORY' });
  assert.equal(first.units[0].source.entry_id, undefined);
  assert.equal(first.units[0].source.observation_index, 0);
  data.entries.push({ id: 'other', parentId: null });
  data.leaf = 'other';
  assert.equal(observer.read(args, ctx).observation.reason, 'input_branch_changed');
  observer.capture({ messages: [{ role: 'user', content: 'NEW' }] }, ctx);
  const next = observer.read(args, ctx);
  assert.notEqual(next.observation.id, first.observation.id);
  assert.equal(next.units[0].message.content, 'NEW');
  data.file = '/private/b.jsonl';
  data.id = 'native-b';
  assert.equal(observer.read(args, ctx).observation.reason, 'session_changed');
  observer.reset();
  assert.equal(observer.read(args, ctx).observation.reason, 'no_observation');
  // Owned factory reload keeps the same owner generation and ordering counter.
  const replacement = new ContextObservation('generation', observer.counter);
  replacement.reset();
  replacement.capture({ messages: [{ role: 'user', content: 'RELOADED' }] }, ctx);
  assert.ok(replacement.read(args, ctx).capture_sequence > next.capture_sequence);
});

test('runtime pages share native cleaning, Unicode paging and frozen cursor budgets without native selectors', () => {
  const { ctx, observer } = fixture();
  const body = Array.from(
    { length: 60 },
    (_, i) => 'Paragraph ' + i + ' 漢😀'.repeat(30) + '\n\n',
  ).join('');
  observer.capture({ messages: [{ role: 'user', content: body }] }, ctx);
  const snapshot = observer.read(args, ctx),
    cache = new ContextReadCache(),
    identity = { session_id: args.session_id, file: 'a', native_id: 'native-a' };
  let page = cache.render(snapshot, { ...args, max_bytes: 4096 }, { identity });
  const pages = [page];
  assert.ok(page.next_cursor);
  observer.capture({ messages: [{ role: 'user', content: 'LATER' }] }, ctx);
  while (page.next_cursor) {
    const a = { cursor: page.next_cursor, max_bytes: 4096 },
      captured = cache.get(a, identity);
    page = cache.render(captured.snapshot, a, { ...captured, identity });
    pages.push(page);
  }
  assert.equal(
    [...pages]
      .reverse()
      .flatMap((p) => p.items)
      .map((u) => u.message?.content ?? '')
      .join(''),
    body,
  );
  for (const p of pages) {
    assert.equal(p.view, 'runtime');
    assert.equal(p.selection, null);
    assert.equal(p.observation.id, snapshot.observation.id);
    assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 4096);
  }
  const cursor = pages[0].next_cursor;
  for (const override of [
    { view: 'session' },
    { preset: 'full' },
    { select: { tools: 0 } },
    { leaf_id: null },
  ])
    assert.throws(() => cache.get({ cursor, ...override }, identity), /STALE_CURSOR/);
  for (const override of [{ preset: 'full' }, { select: {} }, { leaf_id: null }])
    assert.equal(readSchema.safeParse({ ...args, ...override }).success, false);
});

test('runtime assistant parts retain completion state without repeating large error metadata', () => {
  const { ctx, observer } = fixture();
  const body = 'Partial 漢😀 answer\n'.repeat(1500),
    errorMessage = 'PROVIDER_DETAIL '.repeat(1500);
  for (const stopReason of ['error', 'aborted']) {
    observer.capture(
      { messages: [{ role: 'assistant', content: [text(body)], stopReason, errorMessage }] },
      ctx,
    );
    const snapshot = observer.read(args, ctx),
      cache = new ContextReadCache(),
      identity = { session_id: args.session_id };
    assert.equal(
      snapshot.units.filter((unit) => unit.message?.errorMessage === errorMessage).length,
      1,
    );
    let page = cache.render(snapshot, { ...args, max_bytes: 4096 }, { identity });
    assert.ok(page.next_cursor);
    const pages = [page];
    while (page.next_cursor) {
      const next = { cursor: page.next_cursor, max_bytes: 4096 },
        captured = cache.get(next, identity);
      page = cache.render(captured.snapshot, next, { ...captured, identity });
      pages.push(page);
    }
    const parts = [...pages]
      .reverse()
      .flatMap((p) => p.items.filter((unit) => unit.message?.content));
    assert.ok(parts.every((unit) => unit.message.stopReason === stopReason));
    assert.equal(
      parts
        .flatMap((unit) => unit.message.content)
        .map((block) => block.text)
        .join(''),
      body,
    );
    assert.ok(pages.every((p) => Buffer.byteLength(JSON.stringify(p)) <= 4096));
  }
});

test('retention keeps the latest successful capture with bounded memory, identity checks and ordered publication', () => {
  const { ctx, observer } = fixture(),
    runtime = {},
    store = new RetainedObservations({ maxEntries: 1, maxBytes: 100000 });
  observer.capture({ messages: [{ role: 'user', content: 'ONE' }] }, ctx);
  const session = {
    id: args.session_id,
    file: '/private/a.jsonl',
    header: { id: 'native-a', cwd: '/project' },
  };
  const older = observer.read(args, ctx);
  store.put(session, older, runtime);
  assert.equal(
    store.get({ ...session, header: { ...session.header, cwd: '/other' } }).observation.reason,
    'session_changed',
  );
  store.put(session, observer.read(args, ctx), runtime);
  const other = { ...session, id: 'ps_other', file: '/private/other.jsonl' };
  store.put(other, observer.read({ ...args, session_id: other.id }, ctx), {});
  assert.equal(store.entries.size, 1);
  assert.equal(store.get(session).observation.reason, 'no_retained_observation');
  assert.ok(store.accountedBytes <= store.maxBytes);
  const tiny = new RetainedObservations({ maxBytes: 1 });
  tiny.put(session, observer.read(args, ctx), runtime);
  assert.equal(tiny.entries.size, 0);
  assert.equal(tiny.accountedBytes, 0);
  observer.capture({ messages: [{ role: 'user', content: 'NEWER' }] }, ctx);
  store.put(session, observer.read(args, ctx), runtime);
  store.delete(session.id);
  store.put(session, older, runtime);
  assert.equal(store.get(session).observation.reason, 'no_retained_observation');
  const lastSuccess = observer.read(args, ctx);
  store.put(session, lastSuccess, runtime);
  observer.capture({ messages: null }, ctx);
  const failed = observer.read(args, ctx);
  store.put(session, failed, runtime);
  store.put(session, older, runtime);
  assert.equal(store.get(session).observation.id, lastSuccess.observation.id);
  assert.equal(failed.observation.available, false);
  assert.deepEqual(failed.units, []);
  assertReadSnapshot(failed, args);
  assert.equal(checkObservation(failed, { entries: [], leafId: null }), failed);
});
