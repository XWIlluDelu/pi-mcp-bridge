import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderContextRead } from './fixtures/read-pages.mjs';

const text = (value) => ({ type: 'text', text: value });
function history(messages) {
  return messages.map((message, index) => ({
    type: 'message',
    id: 'e' + index,
    parentId: index ? 'e' + (index - 1) : null,
    message,
  }));
}
function read(entries, options = {}) {
  return renderContextRead(
    { header: { id: 'native' }, entries, leafId: entries.at(-1)?.id ?? null },
    { session_id: 'selection-fixture', max_bytes: 65536, ...options },
  );
}
const user = (content) => ({ role: 'user', content });
const answer = (content) => ({ role: 'assistant', content: [text(content)] });
const tool = (id, isError = false) => [
  {
    role: 'assistant',
    content: [{ type: 'toolCall', id, name: 'bash', arguments: { command: 'synthetic ' + id } }],
  },
  { role: 'toolResult', toolCallId: id, isError, content: [text('result ' + id)] },
];

test('tool floods do not displace selected instructions, interior conclusions or correction ownership', () => {
  const messages = [
    user('INITIAL_DIRECTION'),
    answer('INITIAL_RESPONSE'),
    user('INTERIOR_INSTRUCTION'),
    answer('INTERIOR_CONCLUSION'),
    user('LATER_CORRECTION'),
  ];
  for (let i = 0; i < 100; i++) messages.push(...tool('tool-' + i, i === 98));
  messages.push(answer('CORRECTION_RESPONSE'), user('continue'), answer('OK'));
  const entries = history(messages),
    before = JSON.stringify(entries);
  const result = read(entries, { preset: 'full', select: { thinking: 0, tools: 2 } });
  for (const marker of [
    'INITIAL_DIRECTION',
    'INTERIOR_INSTRUCTION',
    'INTERIOR_CONCLUSION',
    'LATER_CORRECTION',
    'CORRECTION_RESPONSE',
  ])
    assert.ok(JSON.stringify(result).includes(marker), marker);
  assert.deepEqual(
    result.items.filter((r) => r.type === 'tool_call').map((r) => r.call_id),
    ['tool-0', 'tool-1', 'tool-98', 'tool-99'],
  );
  assert.deepEqual(
    result.items.filter((r) => r.type === 'tool_result').map((r) => r.message.isError),
    [false, false, true, false],
  );
  assert.ok(
    result.items.filter((r) => r.type.startsWith('tool_')).every((r) => r.prompt_id === 'e4'),
  );
  assert.equal(result.omissions.selection.tools, 96);
  assert.equal(result.omissions.selection.prompts, 0);
  assert.equal(JSON.stringify(entries), before, 'selection does not mutate native history');
});

test('first/last sampling is source-stable with thousands of blocks and reports intentional omissions', () => {
  const content = Array.from({ length: 1000 }, (_, index) => text('BLOCK_' + index));
  const entries = history([user('task'), { role: 'assistant', content }]);
  const result = read(entries, { select: { text: 1, thinking: 0, tools: 0 } });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.source.block_index),
    [0, 999],
  );
  assert.equal(result.omissions.selection.text, 998);
  assert.ok(!JSON.stringify(result).includes('BLOCK_499'));
  const repeated = read(entries, { select: { text: 1, thinking: 0, tools: 0 }, max_bytes: 4096 });
  assert.deepEqual(repeated.selection, result.selection);
  assert.deepEqual(repeated.items, result.items);
  assert.deepEqual(repeated.omissions.selection, result.omissions.selection);
});

test('earliest/recent prompt union is independent of surrounding tool count and preserves repeated inputs', () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push(user('same input'), answer('answer-' + i));
    if (i === 20) for (let j = 0; j < 100; j++) messages.push(...tool('interior-' + j));
  }
  const entries = history(messages),
    prompts = entries.filter((e) => e.message.role === 'user');
  const result = read(entries, { select: { earliest_prompts: 2, recent_prompts: 2, tools: 0 } });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    [prompts[0].id, prompts[1].id, prompts[38].id, prompts[39].id],
  );
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.block.text),
    ['answer-0', 'answer-1', 'answer-38', 'answer-39'],
  );
  assert.equal(result.omissions.selection.prompts, 36);
  assert.equal(result.omissions.selection.tools, 100);
});

test('native replacement is selected at original source positions without reviving hidden content', () => {
  const entries = history([user('task'), answer('ORIGINAL_PRIVATE'), answer('HIDDEN_PRIVATE')]);
  entries.push(
    {
      type: 'context_edit',
      id: 'replace',
      parentId: 'e2',
      targetId: 'e1',
      replacement: {
        content: [
          {
            type: 'thinking',
            thinking: 'omitted reasoning',
            thinkingSignature: 'OPAQUE_SIGNATURE',
          },
          text('REPLACEMENT_FIRST'),
          text('REPLACEMENT_MIDDLE'),
          text('REPLACEMENT_LAST'),
        ],
      },
    },
    { type: 'context_edit', id: 'hide', parentId: 'replace', targetId: 'e2', replacement: null },
  );
  const result = read(entries, { select: { thinking: 0, text: 1 } });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.block.text),
    ['REPLACEMENT_FIRST', 'REPLACEMENT_LAST'],
  );
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.source.block_index),
    [1, 3],
  );
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('OPAQUE_SIGNATURE'));
  assert.equal(result.omissions.selection.thinking, 1);
  assert.equal(result.omissions.selection.text, 1);
  assert.equal(read(entries, { leaf_id: 'e1' }).items.at(-1).block.text, 'ORIGINAL_PRIVATE');
});

test('failed result remains an orphan after native context edit hides its original call', () => {
  const entries = history([user('task'), ...tool('hidden', true)]);
  entries[1].message.content[0].arguments.command = 'HIDDEN_COMMAND';
  entries.push({
    type: 'context_edit',
    id: 'hide',
    parentId: 'e2',
    targetId: 'e1',
    replacement: null,
  });
  const result = read(entries, { select: { tools: -1 } }),
    record = result.items.find((r) => r.type === 'tool_result');
  assert.equal(record.pairing, 'orphan_result');
  assert.equal(record.message.isError, true);
  assert.equal(record.call_source, undefined);
  assert.equal(record.prompt_id, 'e0');
  assert.ok(!JSON.stringify(result).includes('HIDDEN_COMMAND'));
  assert.equal(
    read(entries, { select: { tools: 0 } }).items.some((r) => r.type === 'tool_result'),
    false,
  );
});

test('active summaries exclude superseded and context-hidden parts at each native branch leaf', () => {
  const entries = [
    { type: 'message', id: 'u', parentId: null, message: user('old task') },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 'u',
      summary: 'SUPERSEDED',
      firstKeptEntryId: 'u',
      tokensBefore: 10,
    },
    { type: 'message', id: 'kept', parentId: 'c1', message: user('retained task') },
    {
      type: 'compaction',
      id: 'c2',
      parentId: 'kept',
      summary: 'ACTIVE',
      firstKeptEntryId: 'c1',
      tokensBefore: 20,
    },
    {
      type: 'branch_summary',
      id: 'branch',
      parentId: 'c2',
      fromId: 'kept',
      summary: 'HIDDEN_BRANCH',
    },
    { type: 'context_edit', id: 'hide', parentId: 'branch', targetId: 'branch', replacement: null },
  ];
  const summaries = (result) =>
    result.items
      .filter((r) => r.type === 'summary')
      .flatMap((r) => r.parts.map((p) => p.message.summary));
  assert.deepEqual(summaries(read(entries, { preset: 'recent' })), ['ACTIVE']);
  assert.deepEqual(summaries(read(entries, { preset: 'recent', leaf_id: 'branch' })), [
    'ACTIVE',
    'HIDDEN_BRANCH',
  ]);
  assert.deepEqual(summaries(read(entries, { preset: 'recent', leaf_id: 'kept' })), ['SUPERSEDED']);
  assert.deepEqual(summaries(read(entries, { leaf_id: null })), []);
});

test('split-turn compaction keeps failed/repaired tools and conclusion attached to one synthetic prefix', () => {
  const entries = history([
    user('OLD_USER_NOT_RETAINED'),
    ...tool('failed', true),
    ...tool('repair', false),
    answer('retained conclusion'),
  ]);
  entries.push(
    { type: 'custom', id: 'private', parentId: 'e5', customType: 'state', data: 'RAW_ONLY_STATE' },
    {
      type: 'compaction',
      id: 'split',
      parentId: 'private',
      summary: 'current summary',
      firstKeptEntryId: 'e1',
      tokensBefore: 100,
    },
    { type: 'message', id: 'new', parentId: 'split', message: user('NEW_CORRECTION') },
  );
  const result = read(entries, { preset: 'recent', select: { tools: -1 } }),
    prefix = result.items.find((r) => r.type === 'prompt' && r.synthetic);
  assert.equal(prefix.reason, 'context_prefix');
  const records = result.items.filter((r) => ['tool_call', 'tool_result', 'text'].includes(r.type));
  assert.ok(records.every((r) => r.prompt_id === prefix.prompt_id));
  assert.deepEqual(
    records.filter((r) => r.type === 'tool_result').map((r) => r.message.isError),
    [true, false],
  );
  assert.equal(result.items.at(-1).prompt_id, 'new');
  assert.ok(!JSON.stringify(result).includes('OLD_USER_NOT_RETAINED'));
  assert.ok(!JSON.stringify(result).includes('RAW_ONLY_STATE'));
});

test('selection does not serialize deliberately omitted tool-result payloads', () => {
  const entries = history([user('initial'), answer('previous answer'), user('new request')]);
  for (let i = 0; i < 64; i++)
    entries.push(
      ...history(tool('call-' + i)).map((entry, index) => ({
        ...entry,
        id: 'tool-' + i + '-' + index,
        parentId: index ? 'tool-' + i + '-0' : entries.at(-1).id,
      })),
    );
  const results = entries.filter((e) => e.message.role === 'toolResult');
  for (const result of results)
    result.message.content = [
      {
        type: 'text',
        get text() {
          assert.fail('omitted tool body must not be serialized');
        },
      },
    ];
  const rendered = read(entries, { select: { tools: 0 } });
  assert.equal(rendered.items.filter((r) => r.type.startsWith('tool_')).length, 0);
  assert.equal(rendered.omissions.selection.tools, 64);
});
