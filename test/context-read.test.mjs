import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { readSchema, FULL_SELECTION, RECENT_SELECTION } from '../src/read-schema.mjs';
import {
  renderContextRead,
  assertContextReadResponse,
  rebudgetContextRead,
} from '../src/context-read.mjs';

const msg = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
const text = (value) => ({ type: 'text', text: value });
const thought = (value) => ({ type: 'thinking', thinking: value, thinkingSignature: 'opaque' });
const call = (id) => ({
  type: 'toolCall',
  id,
  name: 'read',
  arguments: { path: '/synthetic/file' },
});
const snapshot = (entries, leafId = entries.at(-1)?.id ?? null) => ({
  header: { id: 'native-session' },
  entries,
  leafId,
  revision: 'intentionally-unused',
});
const args = { session_id: 'public-session', max_bytes: 65536 };
const render = (data, options = {}) => renderContextRead(data, { ...args, ...options });
const zero = {
  summary: 0,
  recent_prompts: 0,
  earliest_prompts: 0,
  text: 0,
  thinking: 0,
  tools: 0,
  commands: 0,
};
function allPages(data, options = {}) {
  let cursor,
    pages = [];
  do {
    const request = { ...args, ...options, cursor };
    const page = renderContextRead(data, request);
    assertContextReadResponse(page, request);
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= (options.max_bytes ?? 65536));
    pages.push(page);
    cursor = page.next_cursor;
    assert.ok(pages.length < 2000, 'pagination makes progress');
  } while (cursor);
  return pages;
}
function reassemble(pages) {
  const records = new Map();
  for (const page of pages)
    for (const item of page.items) {
      const parts = records.get(item.record_index) ?? [];
      parts.push(item);
      records.set(item.record_index, parts);
    }
  return [...records]
    .sort(([a], [b]) => a - b)
    .map(([, parts]) => {
      if (parts[0].type !== 'fragment') {
        assert.equal(parts.length, 1);
        return parts[0];
      }
      parts.sort((a, b) => a.offset - b.offset);
      let end = 0,
        encoded = '';
      for (const part of parts) {
        assert.equal(part.offset, end);
        assert.ok(part.json_fragment.isWellFormed());
        encoded += part.json_fragment;
        end += part.json_fragment.length;
      }
      assert.equal(end, parts[0].total_units);
      return JSON.parse(encoded);
    });
}

test('public schema is strict, finite and independent of legacy views', () => {
  assert.ok(readSchema.safeParse({ session_id: 's' }).success);
  for (const value of [4096, 24000, 65536])
    assert.ok(readSchema.safeParse({ session_id: 's', max_bytes: value }).success);
  for (const select of [zero, FULL_SELECTION, RECENT_SELECTION, { text: 0, thinking: 4 }])
    assert.ok(readSchema.safeParse({ session_id: 's', select }).success);
  for (const invalid of [
    { view: 'raw' },
    { limit: 1 },
    { max_chars: 4096 },
    { select: { other: 2 } },
    { select: { text: -2 } },
    { select: { text: 0.5 } },
    { select: { text: Infinity } },
    { select: { summary: 2 } },
    { max_bytes: 4095 },
    { max_bytes: 65537 },
    { preset: 'overview' },
    { leaf_id: '' },
  ])
    assert.equal(
      readSchema.safeParse({ session_id: 's', ...invalid }).success,
      false,
      JSON.stringify(invalid),
    );
});

test('full context preserves chronological blocks, native system/custom/images and excludes raw state', () => {
  const entries = [
    msg('system', null, 'system', '', {
      sections: { rules: 'SYSTEM', removed: null },
      toolsAdded: [{ name: 'read', parameters: { type: 'object' } }],
    }),
    msg('user', 'system', 'user', [
      text('same prompt'),
      { type: 'image', mimeType: 'image/png', data: 'IMAGE' },
    ]),
    msg('assistant', 'user', 'assistant', [thought('reason'), text('answer'), call('c')], {
      stopReason: 'toolUse',
      usage: { input: 4 },
    }),
    msg(
      'result',
      'assistant',
      'toolResult',
      [text('tool output'), { type: 'image', mimeType: 'image/png', data: 'RESULT_IMAGE' }],
      { toolCallId: 'c', isError: false },
    ),
    {
      type: 'custom_message',
      id: 'custom',
      parentId: 'result',
      timestamp: '2026-01-01T00:00:00Z',
      customType: 'fixture',
      content: [{ type: 'image', mimeType: 'image/png', data: 'CUSTOM_IMAGE' }],
      display: false,
      details: { kept: true },
    },
    {
      type: 'custom',
      id: 'state',
      parentId: 'custom',
      customType: 'private_state',
      data: { not_context: true },
    },
    msg('user2', 'state', 'user', 'same prompt'),
    msg('future', 'user2', 'futureRole', [{ type: 'futureBlock', payload: 'native' }]),
  ];
  const result = render(snapshot(entries));
  assert.deepEqual(result.selection, FULL_SELECTION);
  assert.deepEqual(
    result.items.map((r) => r.type),
    [
      'system',
      'prompt',
      'thinking',
      'text',
      'tool_call',
      'tool_result',
      'custom',
      'prompt',
      'native',
    ],
  );
  assert.deepEqual(result.items[0].message, entries[0].message);
  assert.deepEqual(result.items[1].message, entries[1].message);
  assert.deepEqual(result.items[5].message, entries[3].message);
  assert.equal(result.items[6].message.content[0].data, 'CUSTOM_IMAGE');
  assert.equal(result.items[2].block.thinkingSignature, 'opaque');
  assert.equal(result.items[2].metadata.stopReason, 'toolUse');
  assert.equal(result.items[4].tool_id, result.items[5].tool_id);
  assert.equal(result.items[5].prompt_id, 'user');
  assert.equal(result.items[7].prompt_id, 'user2', 'identical actual inputs are not deduplicated');
  assert.ok(!JSON.stringify(result).includes('private_state'));
  assert.deepEqual(result.omissions.selection, {
    summary: 0,
    prompts: 0,
    text: 0,
    thinking: 0,
    tools: 0,
    commands: 0,
  });
  assertContextReadResponse(result, args);
});

test('native context-hidden user boundaries prevent reassignment to earlier visible inputs', () => {
  const entries = [
    msg('a', null, 'user', 'A'),
    msg('out-a', 'a', 'assistant', [text('answer A')]),
    msg('hidden', 'out-a', 'user', 'SECRET HIDDEN PROMPT'),
    msg('out-b', 'hidden', 'assistant', [text('answer B')]),
    { type: 'context_edit', id: 'hide', parentId: 'out-b', targetId: 'hidden', replacement: null },
  ];
  const result = render(snapshot(entries));
  const boundary = result.items.find((r) => r.reason === 'hidden_user');
  assert.ok(boundary.synthetic);
  assert.equal(boundary.message.content, '');
  assert.equal(
    result.items.find((r) => r.source.entry_id === 'out-b').prompt_id,
    boundary.prompt_id,
  );
  assert.ok(!JSON.stringify(result).includes('SECRET HIDDEN PROMPT'));
  const recent = render(snapshot(entries), { select: { ...zero, recent_prompts: 1, text: -1 } });
  assert.deepEqual(
    recent.items.map((r) => r.source.entry_id),
    ['hidden', 'out-b'],
  );
  assert.equal(recent.omissions.selection.prompts, 1);
  const early = render(snapshot(entries), { select: { ...zero, earliest_prompts: 1, text: -1 } });
  assert.deepEqual(
    early.items.map((r) => r.source.entry_id),
    ['a', 'out-a'],
  );
});

test('synthetic context prefix survives compaction that retains only an assistant suffix', () => {
  const entries = [
    msg('u', null, 'user', 'original'),
    msg('suffix', 'u', 'assistant', [text('suffix')]),
    {
      type: 'compaction',
      id: 'cmp',
      parentId: 'suffix',
      summary: 'summary',
      firstKeptEntryId: 'suffix',
      tokensBefore: 100,
    },
  ];
  const result = render(snapshot(entries));
  assert.deepEqual(
    result.items.map((r) => r.type),
    ['summary', 'prompt', 'text'],
  );
  assert.equal(result.items[1].reason, 'context_prefix');
  assert.equal(result.items[1].prompt_id, result.items[2].prompt_id);
  assert.ok(!JSON.stringify(result).includes('original'));
});

test('tool pairing precedes prompt selection and keeps a steering result in source order', () => {
  const entries = [
    msg('a', null, 'user', 'A'),
    msg('call', 'a', 'assistant', [call('c')]),
    msg('b', 'call', 'user', 'steering B'),
    msg('result', 'b', 'toolResult', [text('result for A')], { toolCallId: 'c' }),
    msg('answer-b', 'result', 'assistant', [text('answer B')]),
  ];
  const result = render(snapshot(entries));
  assert.deepEqual(
    result.items.map((r) => r.source.entry_id),
    ['a', 'call', 'b', 'result', 'answer-b'],
  );
  assert.equal(result.items[3].prompt_id, 'a');
  assert.equal(result.items[4].prompt_id, 'b');
  const a = render(snapshot(entries), { select: { ...zero, earliest_prompts: 1, tools: 1 } });
  assert.deepEqual(
    a.items.map((r) => r.source.entry_id),
    ['a', 'call', 'result'],
  );
  const b = render(snapshot(entries), {
    select: { ...zero, recent_prompts: 1, tools: -1, text: -1 },
  });
  assert.deepEqual(
    b.items.map((r) => r.source.entry_id),
    ['b', 'answer-b'],
  );
  assert.equal(b.omissions.selection.tools, 1);
});

test('tool units retain unresolved calls, orphan results and repeated call IDs without text deduplication', () => {
  const entries = [
    msg('u', null, 'user', 'work'),
    msg('c1', 'u', 'assistant', [call('same')]),
    msg('r1', 'c1', 'toolResult', [text('one')], { toolCallId: 'same' }),
    msg('c2', 'r1', 'assistant', [call('same'), call('unfinished')]),
    msg('r2', 'c2', 'toolResult', [text('two')], { toolCallId: 'same' }),
    msg('orphan', 'r2', 'toolResult', [text('three')], { toolCallId: 'missing' }),
  ];
  const result = render(snapshot(entries));
  const calls = result.items.filter((r) => r.type === 'tool_call'),
    results = result.items.filter((r) => r.type === 'tool_result');
  assert.equal(results[0].tool_id, calls[0].id);
  assert.equal(results[1].tool_id, calls[1].id);
  assert.equal(calls[2].pairing, 'unresolved');
  assert.equal(results[2].pairing, 'orphan_result');
  const sampled = render(snapshot(entries), { select: { ...zero, recent_prompts: 1, tools: 1 } });
  assert.deepEqual(
    sampled.items.map((r) => r.source.entry_id),
    ['u', 'c1', 'r1', 'orphan'],
  );
  assert.equal(sampled.omissions.selection.tools, 2);
});

test('text/thinking sample first and last N blocks per selected prompt, with overlap union', () => {
  let entries = [],
    parent = null;
  for (let p = 0; p < 3; p++) {
    const id = 'u' + p;
    entries.push(msg(id, parent, 'user', 'p' + p));
    parent = id;
    const content = Array.from({ length: 7 }, (_, i) => [
      text('t' + p + i),
      thought('h' + p + i),
    ]).flat();
    const a = 'a' + p;
    entries.push(msg(a, parent, 'assistant', content));
    parent = a;
  }
  const result = render(snapshot(entries), {
    select: { ...zero, earliest_prompts: 1, recent_prompts: 1, text: 2, thinking: 4 },
  });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u0', 'u2'],
  );
  for (const id of ['u0', 'u2']) {
    assert.deepEqual(
      result.items
        .filter((r) => r.type === 'text' && r.prompt_id === id)
        .map((r) => r.source.block_index),
      [0, 2, 10, 12],
    );
    assert.equal(result.items.filter((r) => r.type === 'thinking' && r.prompt_id === id).length, 7);
  }
  assert.equal(result.omissions.selection.text, 13);
  assert.equal(result.omissions.selection.thinking, 7);
  assert.equal(result.omissions.selection.prompts, 1);
});

test('commands select independently, are recent-only, and expose !! exclusion without dropping native output', () => {
  const entries = [
    msg('u', null, 'user', 'input'),
    msg('cmd1', 'u', 'bashExecution', undefined, { command: 'one', output: '1' }),
    msg('cmd2', 'cmd1', 'bashExecution', undefined, {
      command: 'two',
      output: '2',
      excludeFromContext: true,
    }),
    msg('cmd3', 'cmd2', 'bashExecution', undefined, {
      command: 'three',
      output: '3',
      cancelled: true,
    }),
  ];
  const all = render(snapshot(entries));
  assert.equal(all.items.find((r) => r.source.entry_id === 'cmd2').in_model_context, false);
  const recent = render(snapshot(entries), { select: { ...zero, commands: 2 } });
  assert.deepEqual(
    recent.items.map((r) => r.source.entry_id),
    ['cmd2', 'cmd3'],
  );
  assert.equal(recent.omissions.selection.commands, 1);
  assert.equal(recent.omissions.selection.prompts, 1);
});

test('one logical summary contains only active provenance-preserving summaries and keeps system checkpoints', () => {
  const entries = [
    msg('u', null, 'user', 'old'),
    {
      type: 'compaction',
      id: 'old-cmp',
      parentId: 'u',
      summary: 'SUPERSEDED',
      firstKeptEntryId: 'u',
      tokensBefore: 50,
    },
    msg('kept', 'old-cmp', 'assistant', [text('kept')]),
    {
      type: 'branch_summary',
      id: 'branch',
      parentId: 'kept',
      summary: 'BRANCH',
      fromId: 'abandoned',
    },
    {
      type: 'compaction',
      id: 'new-cmp',
      parentId: 'branch',
      summary: 'LATEST',
      firstKeptEntryId: 'old-cmp',
      tokensBefore: 70,
      systemMessage: {
        role: 'system',
        content: '',
        sections: { rules: 'CHECKPOINT' },
        toolsRemoved: [{ name: 'write' }],
        timestamp: 0,
      },
    },
  ];
  const data = snapshot(entries),
    result = render(data);
  const summary = result.items.filter((r) => r.type === 'summary');
  assert.equal(summary.length, 1);
  assert.deepEqual(
    summary[0].parts.map((p) => p.message.summary),
    ['LATEST', 'BRANCH'],
  );
  assert.deepEqual(
    summary[0].parts.map((p) => p.source.entry_id),
    ['new-cmp', 'branch'],
  );
  assert.equal(result.items[0].type, 'system');
  assert.deepEqual(result.items[0].message, entries.at(-1).systemMessage);
  assert.ok(!JSON.stringify(result).includes('SUPERSEDED'));
  const none = render(data, { select: zero });
  assert.deepEqual(
    none.items.map((r) => r.type),
    ['system'],
  );
  assert.equal(none.omissions.selection.summary, 1);
  const projection = buildSessionProjection(entries, data.leafId);
  assert.deepEqual(result.items[0].message, projection.messages[0]);
});

test('default page is newest, pages are chronological and continuation moves backwards', () => {
  const entries = [];
  let parent = null;
  for (let i = 0; i < 30; i++) {
    const id = 'm' + i;
    entries.push(
      msg(id, parent, i % 2 ? 'assistant' : 'user', i % 2 ? [text('answer'.repeat(80))] : 'prompt'),
    );
    parent = id;
  }
  const data = snapshot(entries),
    complete = render(data),
    pages = allPages(data, { max_bytes: 4096 });
  assert.ok(pages.length > 1);
  assert.equal(pages[0].items.at(-1).source.entry_id, 'm29');
  for (const page of pages) {
    assert.deepEqual(
      page.items.map((r) => r.record_index),
      page.items.map((r) => r.record_index).sort((a, b) => a - b),
    );
    assert.deepEqual(page.omissions.selection, {
      summary: 0,
      prompts: 0,
      text: 0,
      thinking: 0,
      tools: 0,
      commands: 0,
    });
  }
  assert.ok(pages[0].omissions.capacity.records_before > 0);
  assert.ok(pages.at(-1).omissions.capacity.records_after > 0);
  assert.deepEqual(reassemble(pages), complete.items);
});

test('UTF8 whole-result budgets split giant native records losslessly without surrogate breaks', () => {
  const value = '😀中文 " \n\\ '.repeat(1800);
  const entries = [
    msg('u', null, 'user', 'input'),
    msg('a', 'u', 'assistant', [text(value)]),
    msg('system', 'a', 'system', '', {
      sections: { huge: value },
      toolsAdded: [{ name: 'x', description: value }],
    }),
  ];
  const data = snapshot(entries),
    pages = allPages(data, { max_bytes: 4096 });
  assert.ok(pages.some((p) => p.items.some((i) => i.type === 'fragment')));
  assert.ok(pages[0].items[0].offset > 0, 'newest giant record starts from its suffix');
  const reconstructed = reassemble(pages);
  assert.equal(reconstructed.find((r) => r.type === 'text').block.text, value);
  assert.deepEqual(reconstructed.find((r) => r.type === 'system').message, entries[2].message);
  assert.ok(
    pages.every((p) => p.omissions.selection.text === 0),
    'capacity is not selection omission',
  );
});

test('continuation freezes leaf across append, metadata, new compaction and context edits', () => {
  const entries = [
    msg('u', null, 'user', 'work'),
    msg('a', 'u', 'assistant', [text('OLD😀'.repeat(2500))]),
  ];
  const old = snapshot(entries),
    first = render(old, { max_bytes: 4096 });
  assert.ok(first.next_cursor);
  const appended = [
    ...entries,
    { type: 'custom', id: 'meta', parentId: 'a', customType: 'state', data: 1 },
    msg('new-user', 'meta', 'user', 'new input'),
    {
      type: 'context_edit',
      id: 'edit',
      parentId: 'new-user',
      targetId: 'a',
      replacement: { content: 'REPLACED' },
    },
    {
      type: 'compaction',
      id: 'compact',
      parentId: 'edit',
      summary: 'NEW SUMMARY',
      firstKeptEntryId: 'compact',
      tokensBefore: 99,
    },
  ];
  const changed = snapshot(appended);
  changed.revision = 'new-file-revision';
  const next = render(changed, { max_bytes: 4096, cursor: first.next_cursor });
  assert.equal(next.leaf_id, 'a');
  assert.equal(next.snapshot, first.snapshot);
  const expected = render(old, { max_bytes: 4096, cursor: first.next_cursor });
  assert.deepEqual(next, expected);
  const fresh = render(changed);
  assert.equal(fresh.leaf_id, 'compact');
  assert.equal(fresh.items[0].parts[0].message.summary, 'NEW SUMMARY');
  assert.deepEqual(render(changed, { leaf_id: 'a' }), render(old, { leaf_id: 'a' }));
});

test('cursors reject missing/rewritten snapshots, changed selectors, identity and malformed offsets', () => {
  const data = snapshot([
    msg('u', null, 'user', 'p'),
    msg('a', 'u', 'assistant', [text('data'.repeat(5000))]),
  ]);
  const page = render(data, { max_bytes: 4096 }),
    cursor = page.next_cursor;
  assert.ok(cursor);
  const stale = (d, options = {}) =>
    assert.throws(() => render(d, { max_bytes: 4096, cursor, ...options }), /STALE_CURSOR/);
  stale(snapshot(data.entries.slice(0, 1)));
  stale({ ...data, header: { id: 'different' } });
  stale(data, { session_id: 'different' });
  stale(data, { leaf_id: 'u' });
  stale(data, { preset: 'recent' });
  stale(data, { select: { text: 0 } });
  const rewritten = structuredClone(data);
  rewritten.entries[1].message.content[0].text += 'changed';
  stale(rewritten);
  assert.throws(() => render(data, { cursor: 'not+base64' }), /INVALID_CURSOR/);
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const patch of [
    { offset: 0 },
    { index: -1 },
    { offset: 1.5 },
    { index: 99999 },
    { offset: 999999 },
  ]) {
    const bad = Buffer.from(JSON.stringify({ ...parsed, ...patch })).toString('base64url');
    assert.throws(() => render(data, { cursor: bad }), /INVALID_CURSOR/);
  }
});

test('explicit null leaf is an empty projection and non-current branches use native ancestry', () => {
  const entries = [
    msg('u', null, 'user', 'root'),
    msg('a', 'u', 'assistant', [text('branch A')]),
    msg('b', 'u', 'assistant', [text('branch B')]),
  ];
  assert.deepEqual(render(snapshot(entries), { leaf_id: null }).items, []);
  assert.equal(render(snapshot(entries), { leaf_id: 'a' }).items.at(-1).block.text, 'branch A');
  assert.throws(() => render(snapshot(entries), { leaf_id: 'missing' }), /ENTRY_NOT_FOUND/);
  assert.deepEqual(render(snapshot([])).items, []);
});

test('captured rebudget works after serialization, including complete and already fragmented records', () => {
  const data = snapshot([
    msg('u', null, 'user', 'prompt'),
    msg('a', 'u', 'assistant', [text('😀escaped"\n'.repeat(600))]),
  ]);
  const complete = render(data);
  for (const original of [complete, render(data, { max_bytes: 4096 })]) {
    const captured = JSON.parse(JSON.stringify(original));
    const reduced = rebudgetContextRead(captured, args, 1800);
    assert.ok(reduced);
    assert.ok(Buffer.byteLength(JSON.stringify(reduced), 'utf8') <= 1800);
    assert.equal(reduced.snapshot, original.snapshot);
    assert.equal(reduced.leaf_id, original.leaf_id);
    assertContextReadResponse(reduced, args);
    const next = render(data, { cursor: reduced.next_cursor, max_bytes: 4096 });
    const last = next.items.at(-1),
      first = reduced.items[0];
    assert.equal(last.record_index, first.record_index);
    assert.equal(last.offset + last.json_fragment.length, first.offset);
  }
  assert.equal(rebudgetContextRead(complete, args, 1), null);
  assert.equal(rebudgetContextRead(complete, args, 65536), complete);
});

test('owner response validator rejects ignored contracts, altered provenance/bindings and budget overflow', () => {
  const data = snapshot([
    msg('u', null, 'user', 'p'),
    msg('a', 'u', 'assistant', [text('X'.repeat(10000))]),
  ]);
  const result = render(data, { max_bytes: 4096 }),
    request = { ...args, max_bytes: 4096 };
  assertContextReadResponse(result, request);
  const reject = (change) => {
    const altered = structuredClone(result);
    change(altered);
    assert.throws(() => assertContextReadResponse(altered, request), /OWNER_READ_REFRESH_REQUIRED/);
  };
  reject((r) => (r.format = 'context'));
  reject((r) => (r.session_id = 'wrong'));
  reject((r) => (r.selection.text = 0));
  reject((r) => (r.items[0].record_index = 999));
  reject((r) => (r.items[0].source = {}));
  reject((r) => (r.items[0].json_fragment = 'X'.repeat(5000)));
  assert.throws(
    () => assertContextReadResponse({ items: [] }, request),
    /OWNER_READ_REFRESH_REQUIRED/,
  );
});

test('live preview stays outside frozen history, obeys selectors, budgets and native availability', () => {
  const entries = [
    msg('u', null, 'user', 'work'),
    msg('a', 'u', 'assistant', [text('saved'.repeat(1500))]),
  ];
  const data = snapshot(entries);
  data.live = {
    available: true,
    source: 'rpc_message_events',
    observed_at: '2026-01-01T00:00:01Z',
    transient: true,
    truncated: false,
    message: { role: 'assistant', content: [thought('live thought'), text('live answer')] },
  };
  const small = render(data, { max_bytes: 4096 });
  assert.equal(small.live.format, 'message');
  assert.equal(small.live.message.content[1].text, 'live answer');
  assert.equal(small.live.prompt_id, 'u');
  assert.equal(small.live.transient, true);
  assert.ok(!JSON.stringify(small.items).includes('live answer'));
  const changed = structuredClone(data);
  changed.live.message.content[1].text = 'new live answer';
  assert.equal(render(changed, { max_bytes: 4096 }).snapshot, small.snapshot);
  const next = render(changed, { max_bytes: 4096, cursor: small.next_cursor });
  assert.equal(next.live, null);
  assert.equal(render(changed, { leaf_id: 'a' }).live, null);
  const filtered = render(data, { select: { ...zero, recent_prompts: 1, text: 0, thinking: -1 } });
  assert.deepEqual(
    filtered.live.message.content.map((b) => b.type),
    ['thinking'],
  );
  assert.equal(filtered.live.selection_omissions.text, 1);
  assert.equal(render(data, { select: zero }).live.omitted_by_selection, true);

  changed.live.message.content = [text('😀中文"\\n'.repeat(2000))];
  changed.live.truncated = true;
  const giant = render(changed, { max_bytes: 4096 });
  assert.equal(giant.live.format, 'json_fragment');
  assert.equal(giant.live.complete, false);
  assert.equal(giant.live.upstream_complete, false);
  assert.ok(giant.live.json_fragment.isWellFormed());
  assert.ok(giant.live.omitted_units > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(giant.live), 'utf8') <= 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(giant), 'utf8') <= 4096);
  const reduced = rebudgetContextRead(JSON.parse(JSON.stringify(giant)), args, 1700);
  assert.ok(reduced);
  assert.equal(reduced.live.omitted_by_capacity, true);
  assert.ok(Buffer.byteLength(JSON.stringify(reduced), 'utf8') <= 1700);
  assertContextReadResponse(reduced, args);

  assert.equal(render(snapshot(entries)).live.available, false);
  const idle = { ...data, live: { available: true, source: 'rpc_message_events', message: null } };
  assert.equal(render(idle).live.message, null);
  const unsupported = {
    ...data,
    live: { available: false, source: 'host_snapshot', reason: 'not_supported' },
  };
  assert.equal(render(unsupported).live.reason, 'not_supported');
});

test('captured rebudget can reduce a live-only empty historical projection', () => {
  const data = snapshot([]);
  data.live = {
    available: true,
    source: 'rpc_message_events',
    message: { role: 'assistant', content: [text('live'.repeat(2000))] },
  };
  const result = render(data),
    reduced = rebudgetContextRead(JSON.parse(JSON.stringify(result)), args, 1400);
  assert.ok(reduced);
  assert.deepEqual(reduced.items, []);
  assert.equal(reduced.live.omitted_by_capacity, true);
  assertContextReadResponse(reduced, args);
});

test('Bridge independently authorizes known-ID reads and rechecks each continuation and completed capture', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-context-permission-'));
  const cwd = path.join(dir, 'project'),
    root = path.join(dir, 'sessions');
  await fs.mkdir(cwd);
  await fs.mkdir(root);
  const entries = [
    msg('u', null, 'user', 'private input'),
    msg('a', 'u', 'assistant', [text('private response'.repeat(1000))]),
  ];
  const file = path.join(root, 'synthetic.jsonl');
  await fs.writeFile(
    file,
    [
      { type: 'session', version: 3, id: 'native-session', cwd, timestamp: '2026-01-01T00:00:00Z' },
      ...entries,
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const config = {
    principal: 'context-test',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [root],
    folders: [{ id: 'project', path: cwd }],
    grants: [{ folder: cwd, list: false, read: true }],
  };
  const bridge = await new Bridge(config, async () => {
    throw new Error('READ_MUST_NOT_SPAWN');
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const [session] = await bridge.sessions();
  assert.deepEqual((await bridge.list()).sessions, [], 'list authorization is independent');
  const first = await bridge.read({ session_id: session.id, max_bytes: 4096 });
  assert.equal(first.format, 'context_timeline');
  assert.ok(first.next_cursor);
  assert.equal(bridge.pool.instances.size, 0);
  config.grants.push({ folder: cwd, read: false });
  await assert.rejects(
    bridge.read({ session_id: session.id, cursor: first.next_cursor, max_bytes: 4096 }),
    /NOT_FOUND_OR_DENIED/,
  );
  config.grants.push({ folder: cwd, read: true });
  bridge.pool.forRead = async () => {
    config.grants.push({ folder: cwd, read: false });
    return null;
  };
  await assert.rejects(
    bridge.read({ session_id: session.id, max_bytes: 4096 }),
    /NOT_FOUND_OR_DENIED/,
  );
});
