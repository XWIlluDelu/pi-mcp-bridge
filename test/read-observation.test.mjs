import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ContextObservation,
  RetainedObservations,
  checkObservation,
} from '../src/context-observation.mjs';

import { assertReadSnapshot } from '../src/context-read.mjs';
import { LiveMessageObserver } from '../src/live-message.mjs';

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
  assert.equal(store.get(session).observation.reason, 'no_retained_observation');
  const tiny = new RetainedObservations({ maxBytes: 1 });
  tiny.put(session, observer.read(args, ctx), runtime);
  assert.equal(tiny.get(session).observation.reason, 'no_retained_observation');
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

test('extension cumulative events produce detached snapshots without assuming delta wire shape', () => {
  const observer = new LiveMessageObserver('extension_message_events'),
    message = { role: 'assistant', content: [{ type: 'text', text: 'partial' }] };
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  observer.update({ type: 'message_update', message });
  message.content[0].text = 'later';
  const snapshot = observer.snapshot();
  assert.equal(snapshot.message.content[0].text, 'partial');
  snapshot.message.content[0].text = 'external mutation';
  assert.equal(observer.snapshot().message.content[0].text, 'partial');
  observer.update({ type: 'agent_settled' });
  assert.equal(observer.snapshot().message, null);
});

test('transient observation memory is bounded, Unicode-safe and explicitly truncated', () => {
  const observer = new LiveMessageObserver('rpc_message_events');
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  observer.update({
    type: 'message_update',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'x'.repeat(65535) + '😀overflow' }],
    },
  });
  const live = observer.snapshot();
  assert.equal(live.truncated, true);
  assert.ok(live.message.content[0].text.length <= 65536);
  assert.ok(live.message.content[0].text.endsWith('😀overflow'));
  assert.equal(live.message.content[0].text.endsWith('�'), false);
  observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
  assert.equal(observer.snapshot().truncated, false);
});

test('tiny and empty cumulative blocks share a bounded tail budget', () => {
  for (const text of ['x', '']) {
    const observer = new LiveMessageObserver('events');
    observer.update({ type: 'message_start', message: { role: 'assistant', content: [] } });
    observer.update({
      type: 'message_update',
      message: {
        role: 'assistant',
        content: Array.from({ length: 5000 }, () => ({ type: 'text', text })),
      },
    });
    const { message, truncated } = observer.snapshot();
    assert.equal(truncated, true);
    assert.equal(message.content.at(-1).index, 4999);
    assert.ok(message.content.reduce((sum, block) => sum + block.text.length + 64, 0) <= 65536);
  }
});
