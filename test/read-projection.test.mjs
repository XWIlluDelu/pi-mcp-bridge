import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sdk } from './fixtures/pi.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import {
  prepareContextRead,
  renderContextRead,
  assertContextReadResponse,
  chronological,
} from './fixtures/read-pages.mjs';

import { prepareContextRead as prepareNativeContext } from '../src/context-read.mjs';
import { validateReadAdapters } from '../src/read-adapters.mjs';
import { CompatibilityServices } from '../src/compatibility-services.mjs';
import intercomModule from '../integrations/intercom/index.mjs';

const msg = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
const text = (value) => ({ type: 'text', text: value });

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
  input: true,
  assistant: 0,
  thinking: 0,
  tool: 0,
  system: false,
  summary: 0,
  memory: 0,
  command: 0,
  native: false,
};
const allContent = { range: { recent: -1 }, content: ALL_CONTENT };
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

test('system instructions and tool declarations are opt-in', () => {
  const system = msg('system', null, 'system', 'PROJECT_RULES', {
    toolsAdded: [{ name: 'declared', description: 'native declaration' }],
  });
  const prompt = msg('input', 'system', 'user', 'task');
  const data = { header: { id: 'fixture' }, entries: [system, prompt], leafId: 'input' };
  const args = { session_id: 'fixture', max_bytes: 8192 };
  assert.doesNotMatch(JSON.stringify(renderContextRead(data, args)), /PROJECT_RULES/);
  const page = renderContextRead(data, { ...args, content: { system: true } });
  assert.match(JSON.stringify(page.items), /PROJECT_RULES/);
  assert.match(JSON.stringify(page.items), /native declaration/);
});

test('generic custom reading preserves repeated business fields and native content across pages', () => {
  const body = 'Native custom body 漢😀\n\n'.repeat(800);
  const repeated = body.slice(-200);
  const details = {
    bodyText: repeated,
    message: {
      content: { text: repeated, attachments: [{ type: 'file', name: 'note', content: 'DATA' }] },
    },
    signature: 'BUSINESS_FIELD',
  };
  const data = snapshot([
    msg('u', null, 'user', 'Review the update'),
    msg('notice', 'u', 'custom', body, { customType: 'fixture-message', details, display: true }),
  ]);
  const before = structuredClone(data);
  for (const max_bytes of [4096, 65536]) {
    const pages = allPages(data, { max_bytes });
    if (max_bytes === 4096) assert.ok(pages.length > 1);
    const units = chronological(pages);
    assert.equal(
      units
        .filter((u) => u.source.entry_id === 'notice')
        .map((u) => u.message?.content ?? '')
        .join(''),
      body,
    );
    assert.deepEqual(units.find((u) => u.message?.details).message.details, details);
    assert.equal(units.filter((u) => u.type === 'prompt').length, 1);
  }
  assert.deepEqual(data, before);
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
  const recent = render(snapshot(entries), {
    range: { recent: 1 },
    content: { ...zero, assistant: -1 },
  });
  assert.deepEqual(
    recent.items.map((r) => r.source.entry_id),
    ['hidden', 'out-b'],
  );
  assert.equal(recent.omissions.selection.turns, 1);
  const early = render(snapshot(entries), {
    range: { earliest: 1, recent: 0 },
    content: { ...zero, assistant: -1 },
  });
  assert.deepEqual(
    early.items.map((r) => r.source.entry_id),
    ['a', 'out-a'],
  );
});

test('tool pairing precedes prompt selection and keeps a steering result in source order', () => {
  const entries = [
    msg('a', null, 'user', 'A'),
    msg('call', 'a', 'assistant', [call('c')]),
    msg('b', 'call', 'user', 'steering B'),
    msg('result', 'b', 'toolResult', [text('result for A')], { toolCallId: 'c' }),
    msg('answer-b', 'result', 'assistant', [text('answer B')]),
  ];
  const result = render(snapshot(entries), { range: { recent: 3 }, content: { tool: -1 } });
  assert.deepEqual(
    result.items.map((r) => r.source.entry_id),
    ['a', 'call', 'b', 'result', 'answer-b'],
  );
  assert.equal(result.items[3].prompt_id, 'a');
  assert.equal(result.items[4].prompt_id, 'b');
  const a = render(snapshot(entries), {
    range: { earliest: 1, recent: 0 },
    content: { ...zero, tool: 1 },
  });
  assert.deepEqual(
    a.items.map((r) => r.source.entry_id),
    ['a', 'call', 'result'],
  );
  const b = render(snapshot(entries), {
    range: { recent: 1 },
    content: { ...zero, tool: -1, assistant: -1 },
  });
  assert.deepEqual(
    b.items.map((r) => r.source.entry_id),
    ['b', 'answer-b'],
  );
  assert.equal(b.omissions.selection.tool, 1);
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
  const result = render(snapshot(entries), { content: { tool: -1 } });
  const calls = result.items.filter((r) => r.type === 'tool_call'),
    results = result.items.filter((r) => r.type === 'tool_result');
  assert.equal(results[0].tool_id, calls[0].tool_id);
  assert.equal(results[1].tool_id, calls[1].tool_id);
  assert.equal(calls[2].pairing, 'unresolved');
  assert.equal(results[2].pairing, 'orphan_result');
  const sampled = render(snapshot(entries), {
    range: { recent: 1 },
    content: { ...zero, tool: 1 },
  });
  assert.deepEqual(
    sampled.items.map((r) => r.source.entry_id),
    ['u', 'orphan'],
  );
  assert.equal(sampled.omissions.selection.tool, 3);
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
  const page = render(snapshot(entries), { content: { tool: -1 }, max_bytes: 4096 });
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

test('explicit native root leaf never falls back to an abandoned tail', () => {
  const page = render(snapshot([msg('u', null, 'user', 'OLD_BRANCH')], null));
  assert.equal(page.leaf_id, null);
  assert.deepEqual(page.items, []);
  assert.ok(!JSON.stringify(page).includes('OLD_BRANCH'));
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
  const pages = allPages(data, { ...allContent, max_bytes: 4096 });
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
  assert.ok(
    !JSON.stringify(render(data, { range: { recent: 0 }, content: zero })).includes(
      'NESTED_REAL_FAILURE',
    ),
  );
  const small = structuredClone(data);
  small.entries.at(-1).message.nestedCalls = { calls: [calls[1]], complete: true };
  assert.deepEqual(
    render(small, { ...allContent }).items.find((u) => u.type === 'tool_result').message
      .nestedCalls,
    { calls: [calls[1]], complete: true },
  );
  const large = structuredClone(data);
  large.entries.at(-1).message.nestedCalls = {
    calls: [{ ...calls[1], arguments: { large: 'X'.repeat(50000) } }],
    complete: true,
  };
  const reduced = chronological(allPages(large, { ...allContent, max_bytes: 4096 })).find(
    (u) => u.type === 'nested_call',
  );
  assert.equal(reduced.nested_call.error, 'NESTED_REAL_FAILURE');
  assert.equal(reduced.nested_call.status, 'error');
  assert.equal(reduced.nested_calls_complete, true);
  assert.ok(reduced.omitted_fields.includes('arguments'));
});

function history(messages) {
  return messages.map((message, index) => ({
    type: 'message',
    id: 'e' + index,
    parentId: index ? 'e' + (index - 1) : null,
    message,
  }));
}
function read(entries, options = {}) {
  const snapshot = prepareContextRead(
    { header: { id: 'native' }, entries, leafId: entries.at(-1)?.id ?? null },
    { session_id: 'selection-fixture', ...options },
  );
  return {
    items: snapshot.units,
    selection: snapshot.selection,
    omissions: { selection: snapshot.omissions },
  };
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

test('message counts preserve all text blocks and select thinking independently', () => {
  const content = Array.from({ length: 1000 }, (_, index) => text('BLOCK_' + index));
  const entries = history([
    user('task'),
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'EARLIER_THINKING' }, text('old answer')],
    },
    { role: 'assistant', content },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'LATEST_THINKING' }] },
  ]);
  const result = read(entries, { content: { assistant: 1, thinking: 1, tool: 0 } });
  const body = result.items.filter((record) => record.type === 'text');
  assert.equal(body.length, 1000);
  assert.equal(body[0].block.text, 'BLOCK_0');
  assert.equal(body.at(-1).block.text, 'BLOCK_999');
  assert.deepEqual(
    result.items
      .filter((record) => record.type === 'thinking')
      .map((record) => record.block.thinking),
    ['LATEST_THINKING'],
  );
  assert.equal(result.omissions.selection.assistant, 1);
  assert.equal(result.omissions.selection.thinking, 1);
  assert.ok(!JSON.stringify(result).includes('old answer'));
  assert.ok(!JSON.stringify(result).includes('EARLIER_THINKING'));
});

test('assistant selection retains a failed thinking-only message independently of thinking', () => {
  const entries = history([
    user('task'),
    answer('earlier progress'),
    {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'unfinished reasoning' }],
      stopReason: 'error',
      errorMessage: 'provider request failed',
    },
  ]);
  const result = read(entries, { content: { assistant: 1, thinking: 0, tool: 0 } });
  const failure = result.items.find((record) => record.message?.role === 'assistant');
  assert.equal(failure.message.stopReason, 'error');
  assert.equal(failure.message.errorMessage, 'provider request failed');
  assert.ok(!JSON.stringify(result).includes('unfinished reasoning'));
  assert.ok(!JSON.stringify(result).includes('earlier progress'));
});

test('earliest/recent prompt union is independent of surrounding tool count and preserves repeated inputs', () => {
  const messages = [];
  for (let i = 0; i < 40; i++) {
    messages.push(user('same input'), answer('answer-' + i));
    if (i === 20) for (let j = 0; j < 100; j++) messages.push(...tool('interior-' + j));
  }
  const entries = history(messages),
    prompts = entries.filter((e) => e.message.role === 'user');
  const result = read(entries, { range: { earliest: 2, recent: 2 }, content: { tool: 0 } });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'prompt').map((r) => r.prompt_id),
    [prompts[0].id, prompts[1].id, prompts[38].id, prompts[39].id],
  );
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.block.text),
    ['answer-0', 'answer-1', 'answer-38', 'answer-39'],
  );
  assert.equal(result.omissions.selection.input, 36);
  assert.equal(result.omissions.selection.tool, 100);
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
  const result = read(entries, { content: { thinking: 0, assistant: 1 } });
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.block.text),
    ['REPLACEMENT_FIRST', 'REPLACEMENT_MIDDLE', 'REPLACEMENT_LAST'],
  );
  assert.deepEqual(
    result.items.filter((r) => r.type === 'text').map((r) => r.source.block_index),
    [1, 2, 3],
  );
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.ok(!JSON.stringify(result).includes('OPAQUE_SIGNATURE'));
  assert.equal(result.omissions.selection.thinking, 1);
  assert.equal(result.omissions.selection.assistant, 0);
  assert.equal(read(entries, { leaf_id: 'e1' }).items.at(-1).block.text, 'ORIGINAL_PRIVATE');
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
  const rendered = read(entries, { content: { tool: 0 } });
  assert.equal(rendered.items.filter((r) => r.type.startsWith('tool_')).length, 0);
  assert.equal(rendered.omissions.selection.tool, 64);
});

const services = new CompatibilityServices();
await intercomModule.start({ id: intercomModule.id, services, onStop() {} });
const [intercom] = services.readInputs.snapshot();
const custom = (id, parentId, customType, content = id) => ({
  type: 'custom_message',
  id,
  parentId,
  customType,
  content,
  display: true,
  timestamp: '2026-01-01T00:00:00Z',
});
const prepare = (entries, args = {}, readAdapters = [intercom]) =>
  prepareNativeContext({ entries }, { session_id: 'fixture', ...args }, { ...sdk, readAdapters });

test('native input descriptors reject invalid and conflicting mappings independently of module loading', () => {
  assert.deepEqual(validateReadAdapters(), []);
  for (const adapters of [
    null,
    {},
    [{}],
    [{ id: 'bad', inputCustomTypes: [] }],
    [{ id: 'bad', inputCustomTypes: [''] }],
    [intercom, intercom],
    [intercom, { id: 'other', inputCustomTypes: ['intercom_message'] }],
    [{ ...intercom, transform: 'unsupported' }],
  ])
    assert.throws(() => validateReadAdapters(adapters), /INVALID_READ_ADAPTER/);
});

test('intercom inputs use native prompt selectors without rewriting message roles, payloads or state', () => {
  const entries = [
    msg('u', null, 'user', 'human'),
    msg('a', 'u', 'assistant', [text('human answer')]),
  ];
  for (let n = 0; n < 4; n++) {
    entries.push(custom('i' + n, entries.at(-1).id, 'intercom_message'));
    entries.push(msg('a' + n, 'i' + n, 'assistant', [text('answer-' + n)]));
  }
  const details = {
    from: { id: 'sender', name: 'Reviewer', cwd: '/project' },
    message: {
      id: 'delivery',
      timestamp: 1,
      brokerDeliveredAt: 2,
      receiverReceivedAt: 3,
      injectedAt: 4,
      content: { text: 'i3', attachments: [{ type: 'file', name: 'note', content: 'ATTACHMENT' }] },
      replyTo: 'prior',
    },
    bodyText: 'i3',
    replyCommand: 'intercom reply',
  };
  entries.find((e) => e.id === 'i3').details = details;
  entries.push(custom('notice', 'a3', 'other-extension', 'not an input'));
  entries.push({
    type: 'custom',
    id: 'state',
    parentId: 'notice',
    customType: 'intercom_message',
    data: { privateState: true },
  });
  const before = structuredClone(entries);
  const full = prepare(entries, { range: { recent: -1 }, content: { tool: -1 } });
  assert.equal(full.units.filter((u) => u.type === 'prompt').length, 5);
  const latest = prepare(entries, { range: { recent: 1 } });
  assert.deepEqual(
    latest.units.map((u) => u.source.entry_id),
    ['i3', 'a3', 'notice'],
  );
  const input = latest.units[0];
  assert.equal(input.type, 'prompt');
  assert.equal(input.prompt_id, 'i3');
  assert.equal(input.message.role, 'custom');
  assert.equal(input.message.customType, 'intercom_message');
  assert.equal(input.source.read_adapter, 'pi-intercom');
  assert.deepEqual(input.message.details, details);
  assert.equal(latest.units[1].prompt_id, 'i3');
  assert.equal(latest.omissions.input, 4);
  const recent = prepare(entries, {});
  assert.deepEqual(
    recent.units.filter((u) => u.type === 'prompt').map((u) => u.prompt_id),
    ['i1', 'i2', 'i3'],
  );
  assert.deepEqual(
    prepare(entries, { range: { recent: 0, earliest: 1 } }).units.map((u) => u.source.entry_id),
    ['u', 'a'],
  );
  const native = prepare(entries, {}, []);
  assert.equal(native.units.filter((u) => u.type === 'prompt').length, 1);
  assert.equal(native.units.find((u) => u.source.entry_id === 'i3').type, 'custom');
  assert.equal(native.units.find((u) => u.source.entry_id === 'a3').prompt_id, 'u');
  assert.ok(!JSON.stringify(full).includes('privateState'));
  assert.deepEqual(entries, before);
});

test('custom input mappings retain native context edits, branch boundaries and tool pairing', () => {
  const entries = [
    custom('i1', null, 'intercom_message', 'first input'),
    msg('call', 'i1', 'assistant', [{ type: 'toolCall', id: 'c', name: 'read', arguments: {} }]),
    custom('i2', 'call', 'intercom_message', 'HIDDEN_INPUT'),
    msg('result', 'i2', 'toolResult', [text('result')], { toolCallId: 'c' }),
    msg('answer', 'result', 'assistant', [text('latest answer')]),
    { type: 'context_edit', id: 'hide', parentId: 'answer', targetId: 'i2', replacement: null },
  ];
  const latest = prepare(entries, { range: { recent: 1 }, content: { tool: -1 } });
  assert.deepEqual(
    latest.units.map((u) => u.source.entry_id),
    ['i2', 'answer'],
  );
  const boundary = latest.units[0];
  assert.equal(boundary.synthetic, true);
  assert.equal(boundary.reason, 'hidden_input');
  assert.equal(boundary.message.role, 'custom');
  assert.equal(boundary.source.read_adapter, intercom.id);
  assert.equal(latest.units[1].prompt_id, boundary.prompt_id);
  assert.ok(!JSON.stringify(latest).includes('HIDDEN_INPUT'));
  const full = prepare(entries, { range: { recent: -1 }, content: { tool: -1 } });
  assert.equal(full.units.find((u) => u.type === 'tool_result').prompt_id, 'i1');
  assert.equal(full.units.find((u) => u.type === 'tool_result').pairing, 'paired');
  const early = prepare(entries, { leaf_id: 'call' });
  assert.equal(early.units[0].prompt_id, 'i1');
  assert.ok(!JSON.stringify(early).includes('latest answer'));
});
