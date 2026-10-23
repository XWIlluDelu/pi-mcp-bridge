import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { SessionManager, buildSessionProjection } from '@earendil-works/pi-coding-agent';
import {
  readSchema,
  FULL_SELECTION,
  RECENT_SELECTION,
  LATEST_SELECTION,
} from '../src/read-schema.mjs';
import { prepareContextRead } from '../src/context-read.mjs';
import { contextWindow } from './fixtures/context-window.mjs';
import {
  renderContextRead,
  assertContextReadResponse,
  chronological,
} from './fixtures/read-pages.mjs';

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
const reassemble = chronological;

test('public read schema validates selectors and byte limits', () => {
  assert.ok(readSchema.safeParse({ session_id: 's' }).success);
  for (const value of [4096, 24000, 65536])
    assert.ok(readSchema.safeParse({ session_id: 's', max_bytes: value }).success);
  for (const select of [
    zero,
    FULL_SELECTION,
    RECENT_SELECTION,
    LATEST_SELECTION,
    { text: 0, thinking: 4 },
  ])
    assert.ok(readSchema.safeParse({ session_id: 's', select }).success);
  for (const invalid of [
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

test('omitted preset is latest, distinct from explicit recent and full, including pagination', () => {
  const data = snapshot(contextWindow()),
    result = render(data);
  assert.equal(readSchema.parse({ session_id: 's' }).preset, undefined);
  assert.deepEqual(result.selection, {
    summary: 0,
    recent_prompts: 1,
    earliest_prompts: 0,
    text: -1,
    thinking: 2,
    tools: 0,
    commands: 0,
  });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u4'],
  );
  assert.equal(result.items.filter((r) => r.type === 'text').length, 8);
  assert.deepEqual(
    result.items.filter((r) => r.type === 'thinking').map((r) => r.block.thinking),
    [0, 1, 6, 7].map((n) => `reason-4-${n}`),
  );
  assert.ok(
    !result.items.some(
      (r) => r.type.startsWith('tool_') || ['summary', 'command'].includes(r.type),
    ),
  );
  assert.deepEqual(result.omissions.selection, {
    summary: 1,
    prompts: 4,
    text: 32,
    thinking: 36,
    tools: 40,
    commands: 1,
  });
  const implicit = allPages(data, { max_bytes: 4096 });
  assert.ok(implicit.length > 1);
  assert.deepEqual(
    reassemble(implicit),
    reassemble(allPages(data, { max_bytes: 4096, preset: 'latest' })),
  );
  assert.deepEqual(reassemble(implicit), result.items);

  const recent = render(data, { preset: 'recent' });
  assert.deepEqual(recent.selection, {
    summary: 1,
    recent_prompts: 3,
    earliest_prompts: 0,
    text: -1,
    thinking: 3,
    tools: 0,
    commands: 0,
  });
  assert.deepEqual(
    recent.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u2', 'u3', 'u4'],
  );
  assert.equal(
    recent.items.find((r) => r.type === 'summary').parts[0].message.summary,
    'WINDOW_SUMMARY',
  );
  assert.equal(recent.items.filter((r) => r.type === 'text').length, 24);
  for (const p of [2, 3, 4])
    assert.deepEqual(
      recent.items
        .filter((r) => r.type === 'thinking' && r.prompt_id === 'u' + p)
        .map((r) => r.block.thinking),
      [0, 1, 2, 5, 6, 7].map((n) => `reason-${p}-${n}`),
    );
  assert.ok(!recent.items.some((r) => r.type.startsWith('tool_') || r.type === 'command'));

  const fullPages = allPages(data, { max_bytes: 4096, preset: 'full' }),
    full = reassemble(fullPages);
  assert.deepEqual(fullPages[0].selection, FULL_SELECTION);
  assert.ok(fullPages.every((p) => Object.values(p.omissions.selection).every((n) => n === 0)));
  assert.deepEqual(
    full.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u0', 'u1', 'u2', 'u3', 'u4'],
  );
  for (const type of ['text', 'thinking', 'tool_call', 'tool_result'])
    assert.equal(full.filter((r) => r.type === type).length, 40, type);
  assert.equal(full.find((r) => r.type === 'summary').parts[0].message.summary, 'WINDOW_SUMMARY');
  assert.equal(full.find((r) => r.type === 'command').message.output, 'shell output');
  assert.equal(
    full.find((r) => r.source.entry_id === 'r0-0').message.content[0].text,
    'output-0-0',
  );
});

test('recent selector overrides add earliest prompts and whole first/last tool units with output', () => {
  const data = snapshot(contextWindow()),
    sampled = render(data, {
      preset: 'recent',
      select: { earliest_prompts: 1, text: 1, thinking: 1, tools: 1 },
    });
  assert.deepEqual(sampled.selection, {
    ...RECENT_SELECTION,
    earliest_prompts: 1,
    text: 1,
    thinking: 1,
    tools: 1,
  });
  assert.deepEqual(
    sampled.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u0', 'u2', 'u3', 'u4'],
  );
  const calls = sampled.items.filter((r) => r.type === 'tool_call');
  assert.deepEqual(
    calls.map((r) => r.call_id),
    [0, 2, 3, 4].flatMap((p) => [`call-${p}-0`, `call-${p}-7`]),
  );
  for (const call of calls) {
    const result = sampled.items.find(
      (r) => r.type === 'tool_result' && r.tool_id === call.tool_id,
    );
    assert.equal(call.pairing, 'paired');
    assert.equal(result.pairing, 'paired');
    assert.equal(result.prompt_id, call.prompt_id);
    assert.deepEqual(call.block.arguments, {
      path: '/synthetic/' + call.call_id.replace('call-', 'file-'),
    });
    assert.equal(result.message.content[0].text, call.call_id.replace('call-', 'output-'));
  }
  assert.equal(sampled.omissions.selection.tools, 32);
  assert.equal(sampled.items.filter((r) => r.type === 'text').length, 8);
  assert.equal(sampled.items.filter((r) => r.type === 'thinking').length, 8);
  const latestTools = render(data, { select: { tools: -1, earliest_prompts: 1 } });
  assert.deepEqual(latestTools.selection, { ...LATEST_SELECTION, tools: -1, earliest_prompts: 1 });
  assert.deepEqual(
    latestTools.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    ['u0', 'u4'],
  );
  assert.equal(latestTools.items.filter((r) => r.type === 'tool_call').length, 16);
  assert.equal(latestTools.items.filter((r) => r.type === 'tool_result').length, 16);
  assert.ok(!latestTools.items.some((r) => r.type === 'summary'));
  const allTools = render(data, { preset: 'recent', select: { tools: -1 } });
  assert.deepEqual(allTools.selection, { ...RECENT_SELECTION, tools: -1 });
  assert.equal(allTools.items.filter((r) => r.type === 'tool_call').length, 24);
  assert.equal(allTools.items.filter((r) => r.type === 'tool_result').length, 24);
  assert.equal(allTools.omissions.selection.tools, 16);
  assert.equal(
    allTools.items.find((r) => r.source.entry_id === 'r2-3').message.content[0].text,
    'output-2-3',
  );
  const fullOverride = reassemble(
    allPages(data, { preset: 'full', select: { recent_prompts: 1 } }),
  );
  assert.equal(
    fullOverride.filter((r) => r.type === 'prompt').length,
    5,
    'full retains earliest_prompts:-1 unless overridden',
  );
});

test('tools selection omits system declarations, not instructions or custom notices', () => {
  const definitions = Array.from({ length: 30 }, (_, i) => ({
    name: 'declared_' + i,
    description: ('DECLARATION_' + i + ' ').repeat(300),
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  }));
  const data = snapshot([
    msg('system', null, 'system', 'GLOBAL_CONTEXT', {
      sections: { rules: 'KEEP_RULE', removed: null },
      toolsAdded: [definitions[0]],
    }),
    msg('u', 'system', 'user', 'USER_WORK mentions toolsAdded'),
    msg('a', 'u', 'assistant', [text('ASSISTANT_WORK'), call('used')]),
    msg('r', 'a', 'toolResult', [text('RESULT_WORK')], { toolCallId: 'used' }),
    {
      type: 'custom_message',
      id: 'notice',
      parentId: 'r',
      timestamp: '2026-01-01T00:00:00Z',
      customType: 'notification',
      content: 'CUSTOM_NOTICE',
      display: true,
      details: { toolsAdded: 'BUSINESS_DATA' },
    },
    msg('update', 'notice', 'system', [text('SYSTEM_NOTICE')], {
      sections: { rules: null },
      toolsRemoved: [{ name: 'retired_tool' }],
    }),
    msg('declarations', 'update', 'system', '', { toolsAdded: definitions }),
  ]);
  const before = structuredClone(data);
  for (const options of [{}, { preset: 'recent' }, { preset: 'full', select: { tools: 0 } }]) {
    const page = render(data, { max_bytes: 4096, ...options });
    assert.equal(page.next_cursor, null, 'default pages must not fill with tool definitions');
    assert.deepEqual(
      page.items.map((item) => item.type),
      ['system', 'prompt', 'text', 'custom', 'system'],
    );
    assert.equal(page.items[0].message.content, 'GLOBAL_CONTEXT');
    assert.deepEqual(page.items[0].message.sections, { rules: 'KEEP_RULE', removed: null });
    assert.equal(page.items[1].message.content, 'USER_WORK mentions toolsAdded');
    assert.equal(page.items[2].block.text, 'ASSISTANT_WORK');
    assert.equal(page.items[3].message.content, 'CUSTOM_NOTICE');
    assert.deepEqual(page.items[3].message.details, { toolsAdded: 'BUSINESS_DATA' });
    assert.deepEqual(page.items[4].message.content, [text('SYSTEM_NOTICE')]);
    assert.deepEqual(page.items[4].message.sections, { rules: null });
    for (const item of page.items.filter((item) => item.type === 'system')) {
      assert.equal(item.message.toolsAdded, undefined);
      assert.equal(item.message.toolsRemoved, undefined);
    }
    assert.equal(page.omissions.selection.tools, 1, 'declarations are not logical tool units');
  }
  for (const options of [{ preset: 'full' }, { select: { tools: 1 } }]) {
    const units = chronological(allPages(data, options));
    assert.deepEqual(
      [
        ...new Set(
          units.flatMap((item) => item.message?.toolsAdded?.map((tool) => tool.name) ?? []),
        ),
      ],
      definitions.map((tool) => tool.name),
    );
    assert.deepEqual(
      units.flatMap((item) => item.message?.toolsRemoved ?? []),
      [{ name: 'retired_tool' }],
    );
    assert.equal(units.filter((item) => item.type.startsWith('tool_')).length, 2);
    for (const definition of definitions) {
      const parts = units
        .filter((item) => item.source.entry_id === 'declarations')
        .flatMap((item) => item.message?.toolsAdded ?? [])
        .filter((tool) => tool.name === definition.name);
      assert.equal(parts.map((tool) => tool.description).join(''), definition.description);
      assert.deepEqual(parts[0].parameters, definition.parameters);
    }
  }
  assert.deepEqual(data, before, 'selection does not mutate native snapshots');
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
  const result = render(snapshot(entries), { preset: 'full' });
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
  assert.equal(result.items[1].message.content[0].text, 'same prompt');
  assert.deepEqual(result.items[1].message.content[1], {
    type: 'image',
    mime_type: 'image/png',
    data_omitted: true,
  });
  assert.equal(result.items[5].message.content[0].text, 'tool output');
  assert.equal(result.items[5].message.content[1].data_omitted, true);
  assert.equal(result.items[6].message.content[0].data_omitted, true);
  assert.equal(result.items[2].block.thinkingSignature, undefined);
  assert.equal(result.items[2].metadata.usage, undefined);
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
  assertContextReadResponse(result, { ...args, preset: 'full' });
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
  const result = render(snapshot(entries), { preset: 'recent' });
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
  const result = render(snapshot(entries), { preset: 'recent', select: { tools: -1 } });
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
  const result = render(snapshot(entries), { select: { tools: -1 } });
  const calls = result.items.filter((r) => r.type === 'tool_call'),
    results = result.items.filter((r) => r.type === 'tool_result');
  assert.equal(results[0].tool_id, calls[0].tool_id);
  assert.equal(results[1].tool_id, calls[1].tool_id);
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
  const all = render(snapshot(entries), { preset: 'full' });
  assert.equal(all.items.find((r) => r.source.entry_id === 'cmd2').in_model_context, false);
  const recent = render(snapshot(entries), { select: { ...zero, commands: 2 } });
  assert.deepEqual(
    recent.items.map((r) => r.source.entry_id),
    ['cmd2', 'cmd3'],
  );
  assert.equal(recent.omissions.selection.commands, 1);
  assert.equal(recent.omissions.selection.prompts, 1);
});

for (const state of [
  { exitCode: 23, cancelled: false, truncated: false },
  { exitCode: undefined, cancelled: true, truncated: false },
  { exitCode: 0, cancelled: false, truncated: true },
])
  test('paged command output keeps nearby native execution state ' + JSON.stringify(state), () => {
    const output = 'partial report 😀 \\"quoted\\"\n'.repeat(2500),
      command = 'generate-partial-report',
      fullOutputPath = '/tmp/native-report.txt',
      data = snapshot([
        msg('cmd', null, 'bashExecution', undefined, {
          command,
          output,
          fullOutputPath,
          ...state,
          excludeFromContext: true,
        }),
      ]);
    const pages = allPages(data, { select: { commands: 1 }, max_bytes: 4096 });
    assert.ok(pages.length > 1);
    const chunks = reassemble(pages).filter((u) => typeof u.message?.output === 'string');
    assert.ok(pages[0].items.some((u) => u.message?.output));
    for (const unit of chunks) {
      assert.equal(unit.type, 'command');
      assert.equal(unit.in_model_context, false);
      assert.equal(unit.message.command, command);
      assert.equal(unit.message.fullOutputPath, fullOutputPath);
      for (const key of ['exitCode', 'cancelled', 'truncated'])
        assert.equal(unit.message[key], state[key]);
      assert.ok(!/[\\uD800-\\uDBFF]$/.test(unit.message.output));
    }
    assert.equal(chunks.map((u) => u.message.output).join(''), output);
    assert.deepEqual(
      chunks.map((u) => u.part),
      Array.from({ length: chunks.length }, (_, i) => i + 1),
    );
  });

test('large command/path metadata stays once without hiding output or repeating across pages', () => {
  const command = 'long-command-'.repeat(1000),
    fullOutputPath = '/' + 'path-'.repeat(2000),
    output = 'native output 😀\n'.repeat(1000),
    data = snapshot([
      msg('cmd', null, 'bashExecution', undefined, {
        command,
        output,
        fullOutputPath,
        exitCode: 23,
        cancelled: false,
        truncated: true,
      }),
    ]);
  const prepared = prepareContextRead(data, { ...args, select: { commands: 1 } });
  for (const key of ['command', 'fullOutputPath'])
    assert.equal(prepared.units.filter((u) => u.message?.[key]).length, 1);
  for (const budget of [4096, 65536]) {
    const pages = allPages(data, { select: { commands: 1 }, max_bytes: budget });
    const chunks = reassemble(pages).filter((u) => typeof u.message?.output === 'string');
    assert.equal(chunks.map((u) => u.message.output).join(''), output);
    assert.ok(chunks.every((u) => u.message.exitCode === 23 && u.message.truncated));
    if (budget === 4096)
      assert.ok(pages.some((p) => p.items.some((u) => u.omitted_fields?.includes('command'))));
    else assert.ok(pages.some((p) => p.items.some((u) => u.message?.command === command)));
  }
});

test('active summaries keep their native positions and system checkpoints', () => {
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
    result = render(data, { preset: 'recent' });
  const summary = result.items.filter((r) => r.type === 'summary');
  assert.equal(summary.length, 2);
  assert.deepEqual(
    summary.flatMap((r) => r.parts.map((p) => p.message.summary)),
    ['LATEST', 'BRANCH'],
  );
  assert.deepEqual(
    summary.flatMap((r) => r.parts.map((p) => p.source.entry_id)),
    ['new-cmp', 'branch'],
  );
  assert.equal(result.items[0].type, 'system');
  const { toolsRemoved, ...instructions } = entries.at(-1).systemMessage;
  assert.deepEqual(result.items[0].message, instructions);
  assert.ok(!JSON.stringify(result).includes('SUPERSEDED'));
  const none = render(data, { select: zero });
  assert.deepEqual(
    none.items.map((r) => r.type),
    ['system'],
  );
  assert.equal(none.omissions.selection.summary, 1);
  const projection = buildSessionProjection(entries, data.leafId);
  assert.deepEqual(render(data, { preset: 'full' }).items[0].message, projection.messages[0]);
});

test('whole readable paragraphs page without loss, duplication or a JSON reconstruction protocol', () => {
  const value = Array.from(
    { length: 100 },
    (_, i) => 'Paragraph-' + i + ' 漢😀"\\ '.repeat(20) + '\n\n',
  ).join('');
  const data = snapshot([
    msg('u', null, 'user', 'task'),
    msg('a', 'u', 'assistant', [text(value)]),
  ]);
  const pages = allPages(data, { max_bytes: 4096 });
  assert.ok(pages.length > 1);
  for (const page of pages) assertContextReadResponse(page, { max_bytes: 4096 });
  const items = chronological(pages);
  assert.equal(
    items
      .filter((unit) => unit.type === 'text')
      .map((unit) => unit.block.text)
      .join(''),
    value,
  );
  assert.equal(items.filter((unit) => unit.type === 'prompt').length, 1);
  assert.ok(
    items.filter((unit) => unit.type === 'text').every((unit) => unit.block.text.endsWith('\n\n')),
  );
});

test('long single-line text pages completely through Unicode-safe source parts', () => {
  const original = 'word 😀\\ boundary '.repeat(5000),
    data = snapshot([msg('u', null, 'user', 'task'), msg('a', 'u', 'assistant', [text(original)])]);
  const pages = allPages(data, { max_bytes: 4096, preset: 'full' }),
    units = chronological(pages).filter((unit) => unit.type === 'text');
  assert.equal(units.map((unit) => unit.block.text).join(''), original);
  assert.ok(units.every((unit) => unit.block.text.isWellFormed()));
  assert.ok(units.every((unit, index) => unit.part === index + 1 && unit.source.entry_id === 'a'));
  assert.ok(pages.length > 1);
});

test('images and native signatures are removed while tool business signature fields remain', () => {
  const entries = [
    msg('u', null, 'user', [
      text('IMPORTANT TASK'),
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50000) },
    ]),
    msg(
      'a',
      'u',
      'assistant',
      [
        { type: 'text', text: 'answer', textSignature: 'NATIVE_SECRET' },
        {
          type: 'thinking',
          thinking: 'reason',
          thinkingSignature: 'NATIVE_SECRET',
          redacted: false,
        },
        {
          type: 'toolCall',
          id: 'c',
          name: 'verify',
          arguments: { signature: 'BUSINESS', nested: { textSignature: 'BUSINESS' } },
        },
      ],
      {
        responseId: 'NATIVE_SECRET',
        usage: { cost: 200 },
        api: 'internal',
        model: 'native',
        stopReason: 'toolUse',
      },
    ),
    msg('r', 'a', 'toolResult', [text('verified')], {
      toolCallId: 'c',
      details: { signature: 'BUSINESS' },
    }),
  ];
  const page = render(snapshot(entries), { select: { tools: -1 }, max_bytes: 4096 });
  assert.ok(JSON.stringify(page).includes('IMPORTANT TASK'));
  assert.ok(!JSON.stringify(page).includes('NATIVE_SECRET'));
  assert.ok(!JSON.stringify(page).includes('AAAAAAA'));
  assert.equal(
    page.items.find((unit) => unit.type === 'tool_call').block.arguments.signature,
    'BUSINESS',
  );
  assert.equal(
    page.items.find((unit) => unit.type === 'tool_result').message.details.signature,
    'BUSINESS',
  );
});

test('live stays transient and readable, with explicit capacity/unavailable fallbacks', () => {
  const data = snapshot([msg('u', null, 'user', 'task')]);
  data.live = {
    available: true,
    source: 'events',
    message: { role: 'assistant', content: [text('live answer'), thought('live thought')] },
  };
  const page = render(data, { max_bytes: 4096 });
  assert.equal(page.live.transient, true);
  assert.equal(page.live.complete, false);
  assert.equal(page.live.items[0].block.text, 'live answer');
  assert.ok(!JSON.stringify(page.items).includes('live answer'));
  data.live.message.content = [text('X'.repeat(20000) + '😀LATEST')];
  const large = render(data, { max_bytes: 4096 });
  assert.equal(large.live.omitted_by_capacity, true);
  assert.ok(large.live.items.at(-1).block.text.endsWith('😀LATEST'));
  assert.ok(large.live.items.at(-1).block.text.isWellFormed());
  const wider = render(data, { max_bytes: 65536 });
  assert.ok(wider.live.items.at(-1).block.text.length > large.live.items.at(-1).block.text.length);
  assert.ok(!JSON.stringify(large).includes('json_fragment'));
  data.live = {
    available: true,
    source: 'events',
    message: { role: 'assistant', content: 'invalid native content' },
  };
  const unavailable = render(data);
  assert.equal(unavailable.live.available, false);
  assert.equal(unavailable.live.reason, 'invalid_live_message');
});

test('explicit native root leaf never falls back to an abandoned tail', () => {
  const page = render(snapshot([msg('u', null, 'user', 'OLD_BRANCH')], null));
  assert.equal(page.leaf_id, null);
  assert.deepEqual(page.items, []);
  assert.ok(!JSON.stringify(page).includes('OLD_BRANCH'));
});

test('large known system sections page by paragraphs despite empty content; declarations remain readable', () => {
  const value = Array.from(
    { length: 100 },
    (_, i) => 'RULE_' + i + ' ' + 'x'.repeat(800) + '\n\n',
  ).join('');
  const data = snapshot([
    msg('system', null, 'system', '', {
      sections: { rules: value },
      toolsAdded: [{ name: 'verify', parameters: { signature: 'BUSINESS' } }],
    }),
  ]);
  const pages = allPages(data, { max_bytes: 4096, preset: 'full' }),
    units = chronological(pages);
  assert.equal(
    units
      .filter((unit) => unit.message.sections)
      .map((unit) => unit.message.sections.rules)
      .join(''),
    value,
  );
  assert.equal(
    units.find((unit) => unit.message.toolsAdded).message.toolsAdded[0].parameters.signature,
    'BUSINESS',
  );
  assert.ok(units.every((unit) => !unit.message.sections_omitted));
});

test('custom records follow their prompt window while context prefixes remain global', () => {
  const data = snapshot([
    msg('prefix', null, 'custom', 'GLOBAL'),
    msg('u1', 'prefix', 'user', 'OLD'),
    msg('c1', 'u1', 'custom', 'OLD_CUSTOM'),
    msg('u2', 'c1', 'user', 'NEW'),
    msg('c2', 'u2', 'custom', 'NEW_CUSTOM'),
  ]);
  const latest = JSON.stringify(render(data, { preset: 'latest' })),
    full = JSON.stringify(render(data, { preset: 'full' }));
  assert.ok(latest.includes('GLOBAL'));
  assert.ok(latest.includes('NEW_CUSTOM'));
  assert.ok(!latest.includes('OLD_CUSTOM'));
  assert.ok(full.includes('OLD_CUSTOM'));
});

test('split multi-block messages retain each native content index and complete text', () => {
  const originals = ['FIRST 😀 '.repeat(900), 'SECOND 😀 '.repeat(900)],
    data = snapshot([msg('u', null, 'user', originals.map(text))]);
  const units = chronological(allPages(data, { preset: 'full', max_bytes: 4096 })).filter(
    (unit) => unit.type === 'prompt',
  );
  for (const [index, original] of originals.entries()) {
    const parts = units.filter((unit) => unit.source.content_index === index);
    assert.ok(parts.length > 1);
    assert.equal(parts.map((unit) => unit.message.content[0].text).join(''), original);
  }
});

test('large tool metadata is stored once, cannot suppress body text and fits small pages with complete source links', () => {
  for (const [bodyLength, detailsLength] of [
    [524288, 30000],
    [524288, 32000],
    [10000, 65000],
  ]) {
    const body = 'T'.repeat(bodyLength),
      details = 'D'.repeat(detailsLength);
    const data = snapshot([
      msg('u', null, 'user', 'inspect'),
      msg('a', 'u', 'assistant', [call('outer')]),
      msg(
        'r',
        'a',
        'toolResult',
        [text(body.slice(0, bodyLength / 2)), text(body.slice(bodyLength / 2))],
        { toolCallId: 'outer', toolName: 'read', isError: false, details },
      ),
    ]);
    const prepared = prepareContextRead(data, { ...args, preset: 'full' });
    assert.ok(
      Buffer.byteLength(JSON.stringify(prepared)) < 2 * Buffer.byteLength(JSON.stringify(data)),
    );
    assert.equal(prepared.units.filter((u) => u.message?.details === details).length, 1);
    const pages = allPages(data, { preset: 'full', max_bytes: 4096 });
    const resultUnits = chronological(pages).filter((u) => u.type === 'tool_result');
    const blocks = resultUnits.flatMap((u) => u.message?.content ?? []);
    assert.equal(blocks.map((b) => b.text ?? '').join(''), body);
    assert.deepEqual(new Set(resultUnits.map((u) => u.source.content_index)), new Set([0, 1]));
    assert.ok(
      pages.some((p) =>
        p.items.some((u) => u.type === 'message_metadata' && u.omitted_fields?.includes('details')),
      ),
    );
    assert.ok(resultUnits.every((u) => u.source.entry_id === 'r' && u.call_id === 'outer'));
  }
});

test('saved nested calls follow their parent selection and page as whole child records, not invented results', () => {
  const calls = Array.from({ length: 256 }, (_, i) => ({
    id: 'nested-' + i,
    name: 'inner',
    ...(i === 1 ? { argumentsBytes: 40000 } : { arguments: { index: i } }),
    status: i === 0 ? 'unfinished' : i === 1 ? 'error' : 'success',
    ...(i === 1 ? { error: 'NESTED_REAL_FAILURE' } : {}),
    durationMs: 1,
  }));
  const nestedCalls = { calls, complete: false };
  const data = snapshot([
    msg('u', null, 'user', 'inspect'),
    msg('a', 'u', 'assistant', [call('outer')]),
    msg('r', 'a', 'toolResult', [text('OUTER_SUCCEEDED')], {
      toolCallId: 'outer',
      toolName: 'read',
      isError: false,
      nestedCalls,
    }),
  ]);
  const pages = allPages(data, { preset: 'full', max_bytes: 4096 });
  const nested = chronological(pages).filter((u) => u.type === 'nested_call');
  assert.deepEqual(
    nested.map((u) => u.nested_call),
    calls,
  );
  assert.ok(pages[0].next_cursor);
  assert.equal(pages.at(-1).next_cursor, null);
  assert.ok(
    nested.every(
      (u) =>
        u.nested_calls_complete === false && u.source.entry_id === 'r' && u.call_id === 'outer',
    ),
  );
  assert.equal(nested[1].nested_call.arguments, undefined);
  assert.equal(nested[1].nested_call.argumentsBytes, 40000);
  assert.ok(!JSON.stringify(render(data, { select: zero })).includes('NESTED_REAL_FAILURE'));
  const small = structuredClone(data);
  small.entries.at(-1).message.nestedCalls = { calls: [calls[1]], complete: true };
  assert.deepEqual(
    render(small, { preset: 'full' }).items.find((u) => u.type === 'tool_result').message
      .nestedCalls,
    { calls: [calls[1]], complete: true },
  );
  const large = structuredClone(data);
  large.entries.at(-1).message.nestedCalls = {
    calls: [{ ...calls[1], arguments: { large: 'X'.repeat(50000) } }],
    complete: true,
  };
  const reduced = chronological(allPages(large, { preset: 'full', max_bytes: 4096 })).find(
    (u) => u.type === 'nested_call',
  );
  assert.equal(reduced.nested_call.error, 'NESTED_REAL_FAILURE');
  assert.equal(reduced.nested_call.status, 'error');
  assert.equal(reduced.nested_calls_complete, true);
  assert.ok(reduced.omitted_fields.includes('arguments'));
});

test('a large native assistant error is shared once per text block while every text part retains its error state', () => {
  const body = 'PARTIAL_BODY '.repeat(4000),
    errorMessage = 'NATIVE_PROVIDER_ERROR '.repeat(1500);
  const data = snapshot([
    msg('u', null, 'user', 'inspect'),
    msg('a', 'u', 'assistant', [text(body)], { stopReason: 'error', errorMessage }),
  ]);
  const prepared = prepareContextRead(data, { ...args, preset: 'full' });
  assert.ok(
    Buffer.byteLength(JSON.stringify(prepared)) < 2 * Buffer.byteLength(JSON.stringify(data)),
  );
  assert.equal(prepared.units.filter((u) => u.metadata?.errorMessage === errorMessage).length, 1);
  const pages = allPages(data, { preset: 'full', max_bytes: 4096 });
  const parts = chronological(pages).filter((u) => u.type === 'text');
  assert.equal(parts.map((u) => u.block.text).join(''), body);
  assert.ok(parts.every((u) => u.metadata.stopReason === 'error'));
  assert.ok(pages.some((p) => p.items.some((u) => u.omitted_fields?.includes('errorMessage'))));
});

test('native branch/compaction summaries stay ordered around long intermediate context and appear on the newest small page', () => {
  for (const compact of [false, true]) {
    const manager = SessionManager.inMemory('/synthetic');
    const user = manager.appendMessage({ role: 'user', content: 'INITIAL_PROMPT', timestamp: 0 });
    if (compact) manager.appendCompaction('FIRST_SUMMARY', user, 100);
    else manager.branchWithSummary(user, 'FIRST_SUMMARY');
    const middle = manager.appendMessage({
      role: 'assistant',
      content: [text('MIDDLE_CONTEXT '.repeat(2600))],
    });
    manager.branchWithSummary(middle, 'LATEST_SUMMARY');
    manager.appendMessage({ role: 'user', content: 'LATEST_PROMPT', timestamp: 0 });
    const data = snapshot(manager.getEntries(), manager.getLeafId());
    const native = buildSessionProjection(data.entries, data.leafId)
      .entries.filter((e) => e.messages.length)
      .map((e) => e.sourceEntry.id);
    for (const summary of [1, -1]) {
      const pages = allPages(data, { preset: 'recent', select: { summary }, max_bytes: 4096 });
      assert.ok(JSON.stringify(pages[0]).includes('LATEST_SUMMARY'));
      assert.ok(JSON.stringify(pages[0]).includes('LATEST_PROMPT'));
      const units = chronological(pages);
      assert.deepEqual([...new Set(units.map((u) => u.source.entry_id))], native);
      assert.deepEqual(
        units
          .filter((u) => u.type === 'summary')
          .flatMap((u) => u.parts.map((p) => p.message.summary)),
        ['FIRST_SUMMARY', 'LATEST_SUMMARY'],
      );
    }
    assert.ok(
      !JSON.stringify(
        allPages(data, { preset: 'recent', select: { summary: 0 }, max_bytes: 4096 }),
      ).includes('LATEST_SUMMARY'),
    );
  }
});
