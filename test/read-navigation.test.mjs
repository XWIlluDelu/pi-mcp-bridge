import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { ContextReadCache } from '../src/read-cache.mjs';
import { appendUnits, prepareContextRead, READ_SNAPSHOT_LIMIT } from '../src/context-read.mjs';
import { navigationDocuments, navigationRows, documentText } from '../src/read-navigation.mjs';
import { contextSelection, readSchema, searchSchema, ALL_CONTENT } from '../src/read-schema.mjs';
import { toolDefinitions } from '../src/protocol.mjs';
import { jsonBytes } from '../src/response-budget.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { buildSessionProjection } from './fixtures/pi.mjs';

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
const rows = (snap, options) => navigationRows(snap, navigationDocuments(snap), (i) => i, options);

function taskHistory({
  task = 'CURRENT TASK: correct rollback and preserve unrelated changes.',
  answer,
  loops = 25,
} = {}) {
  const entries = [];
  const add = (role, content, fields = {}) => {
    entries.push({
      type: 'message',
      id: `entry-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      message: { role, content, ...fields },
    });
  };
  add('user', task);
  for (let i = 0; i < loops; i++) {
    add('assistant', [
      { type: 'text', text: `Progress ${i}: ` + 'investigation details '.repeat(100) },
      { type: 'toolCall', id: `call-${i}`, name: 'bash', arguments: { command: `test step ${i}` } },
    ]);
    add('toolResult', [{ type: 'text', text: 'Step completed.' }], {
      toolCallId: `call-${i}`,
      toolName: 'bash',
      isError: false,
    });
  }
  add(
    'assistant',
    answer ?? [
      { type: 'text', text: 'FINAL CONCLUSION: rollback corrected.' },
      { type: 'text', text: 'VALIDATION: transaction tests passed.' },
      { type: 'text', text: 'NEXT STEP: review the retained changes.' },
    ],
  );
  return { entries, leafId: entries.at(-1).id };
}

test('long tasks keep source order, preserve selected answer blocks and advance one frozen cursor', () => {
  const data = taskHistory();
  for (const max_bytes of [24000, 4096]) {
    const request = { session_id: 'fixture', max_bytes };
    const captured = prepareContextRead(data, request, { buildSessionProjection });
    const cache = new ContextReadCache();
    let page = cache.navigate(captured, request, { identity });
    assert.equal(page.items[0].type, 'input');
    assert.match(page.items[0].text, /CURRENT TASK/);
    const all = [];
    for (let count = 0; ; count++) {
      assert.ok(count < 40, 'pagination terminates');
      assert.ok(jsonBytes(page) <= max_bytes);
      assert.ok(page.items.length);
      all.push(...page.items);
      assert.equal(Boolean(page.next_cursor), page.omissions.capacity.remaining_units > 0);
      if (!page.next_cursor) break;
      const next = cache.get({ cursor: page.next_cursor }, identity);
      page = cache.render(next.snapshot, { max_bytes }, { ...next, identity });
      assert.equal(page.omissions.capacity.previous_units, all.length);
    }
    assert.equal(new Set(all.map((row) => row.ref)).size, all.length);
    assert.deepEqual(
      all.map((row) => row.source.entry_index),
      all.map((row) => row.source.entry_index).sort((a, b) => a - b),
    );
    const answer = all.at(-1);
    assert.match(answer.text, /FINAL CONCLUSION[\s\S]*VALIDATION[\s\S]*NEXT STEP/);
    const expanded = cache.expand([answer.ref], identity);
    assert.deepEqual(
      expanded.units.map((unit) => unit.source.block_index),
      [0, 1, 2],
    );
  }
});

test('a long latest reply shares a chronological page with input and thinking and expands without loss', () => {
  const data = taskHistory({
    task: '当前输入：' + '约束与需求🔎'.repeat(700),
    answer: [
      { type: 'thinking', thinking: '当前判断：' + '理由与方向🔎'.repeat(500) },
      { type: 'text', text: '最新结论：' + '进展与证据🔎'.repeat(700) },
    ],
    loops: 0,
  });
  const request = { session_id: 'fixture', max_bytes: 4096 };
  const captured = prepareContextRead(data, request, { buildSessionProjection });
  const cache = new ContextReadCache();
  const page = cache.navigate(captured, request, { identity });
  assert.ok(jsonBytes(page) <= 4096);
  assert.deepEqual(
    page.items.map((item) => item.type),
    ['input', 'thinking', 'assistant'],
  );
  assert.equal(page.next_cursor, null);
  for (const item of page.items) {
    assert.ok(item.text.length > 0);
    assert.equal(item.truncated, true);
    assert.ok(
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item.text),
    );
    assert.ok(jsonBytes(cache.expand([item.ref], identity).units) > 4096);
  }
});

test('each selected turn keeps a fitting latest reply complete and pages between turns', () => {
  const entries = [];
  const add = (role, content) =>
    entries.push({
      type: 'message',
      id: `entry-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      message: { role, content },
    });
  const answer = 'Conclusion with several independently useful details. '.repeat(32);
  for (let n = 0; n < 3; n++) {
    add('user', `Task ${n}`);
    add('assistant', [{ type: 'text', text: `Plan ${n}: inspect then report.` }]);
    add('assistant', [{ type: 'text', text: `${n}: ${answer}` }]);
  }
  const request = { session_id: 'fixture', max_bytes: 4096 };
  const captured = prepareContextRead({ entries }, request, { buildSessionProjection });
  const cache = new ContextReadCache();
  let page = cache.navigate(captured, request, { identity });
  for (let n = 0; n < 3; n++) {
    assert.deepEqual(
      page.items.map((item) => item.type),
      ['input', 'assistant', 'assistant'],
    );
    assert.equal(page.items.at(-1).text, `${n}: ${answer}`);
    assert.ok(!page.items.at(-1).truncated);
    if (n < 2) {
      const next = cache.get({ cursor: page.next_cursor }, identity);
      page = cache.render(next.snapshot, { max_bytes: 4096 }, { ...next, identity });
    }
  }
  assert.equal(page.next_cursor, null);
});

test('moving a turn to the next page preserves its reply before shrinking it into a page tail', () => {
  const entries = [];
  const add = (role, text) =>
    entries.push({
      type: 'message',
      id: `entry-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      message: { role, content: role === 'user' ? text : [{ type: 'text', text }] },
    });
  add('user', 'Earlier task');
  add('assistant', 'Earlier answer. '.repeat(125));
  add('user', 'Current task');
  add('assistant', 'First investigation details. '.repeat(180));
  add('assistant', 'Second investigation details. '.repeat(180));
  const latest = 'Current conclusion with important qualifications. '.repeat(50);
  add('assistant', latest);
  const request = { session_id: 'fixture', max_bytes: 6000 };
  const captured = prepareContextRead({ entries }, request, { buildSessionProjection });
  const cache = new ContextReadCache();
  const first = cache.navigate(captured, request, { identity });
  assert.deepEqual(
    first.items.map((item) => item.source.entry_id),
    ['entry-0', 'entry-1'],
  );
  const next = cache.get({ cursor: first.next_cursor }, identity);
  const second = cache.render(next.snapshot, { max_bytes: 6000 }, { ...next, identity });
  assert.equal(second.items.at(-1).text, latest);
  assert.ok(!second.items.at(-1).truncated);
  assert.equal(second.next_cursor, null);
  assert.ok(second.items.slice(1, -1).every((item) => item.truncated));
});

test('navigation groups split source parts, separates source namespaces and never deduplicates equal text', () => {
  const snap = snapshot([
    textUnit('a', 'first ', { part: 1 }),
    textUnit('a', 'second', { part: 2 }),
    textUnit('b', 'first second'),
    { type: 'text', text: 'runtime first', source: { observation_index: 0 } },
    { type: 'text', text: 'runtime second', source: { observation_index: 0 } },
    { type: 'memory', text: 'memory', source: { reader_item: '0' } },
  ]);
  const documents = navigationDocuments(snap);
  assert.equal(documents.length, 4);
  assert.equal(documentText(snap, documents[0]), 'first second');
  assert.equal(documentText(snap, documents[2]), 'runtime firstruntime second');
  assert.equal(rows(snap).length, 4);
});

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

test('search examines full split documents and returns a match outside the normal preview', () => {
  const snap = snapshot([
    textUnit('long', 'a'.repeat(2040) + 'NEED', { part: 1 }),
    textUnit('long', 'LE evidence ' + 'z'.repeat(5000), { part: 2 }),
    textUnit('other', 'unrelated'),
  ]);
  assert.doesNotMatch(rows(snap)[0].text, /NEEDLE/);
  const hits = rows(snap, { query: 'needle evidence' });
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /NEEDLE evidence/);
  assert.ok(hits[0].text.length < 650);
  assert.equal(rows(snap, { query: 'needle', content: ['tool'] }).length, 0);
});

for (const view of ['session', 'runtime']) {
  test(`${view} search preserves continuous command output and per-part execution state`, () => {
    const output = Array.from(
      { length: 350 },
      (_, i) => `Entry ${String(i).padStart(4, '0')}: a distinct diagnostic observation.`,
    ).join(' ');
    for (const command of ['generate-diagnostics', 'long-command-'.repeat(100)]) {
      const message = {
        role: 'bashExecution',
        command,
        output,
        exitCode: 23,
        cancelled: true,
        truncated: true,
      };
      const request = {
        session_id: identity.session_id,
        view,
        content: ALL_CONTENT,
        ...(view === 'session' ? { range: { recent: -1 } } : {}),
      };
      const capture = (query) => {
        if (view === 'session')
          return prepareContextRead(
            {
              entries: [{ type: 'message', id: 'command', parentId: null, message }],
              leafId: 'command',
            },
            { ...request, ...(query ? { search_query: query } : {}) },
            { buildSessionProjection },
          );
        const target = { units: [], accountedBytes: 0 };
        appendUnits(target, { type: 'command', source: { observation_index: 0 }, message });
        return snapshot(target.units, { view, selection: null, omissions: null });
      };
      const captured = capture();
      const parts = captured.units.filter((unit) => typeof unit.message?.output === 'string');
      assert.ok(parts.length > 1);
      const boundary = parts[0].message.output.length;
      const phrase = output.slice(boundary - 30, boundary + 30);
      const cache = new ContextReadCache();
      const found = cache.navigate(capture(phrase), request, { identity }, phrase);
      assert.equal(found.matches, 1);
      assert.ok(found.items[0].text.includes(phrase));
      const expanded = cache.expand([found.items[0].ref], identity);
      const expandedParts = expanded.units.filter(
        (unit) => typeof unit.message?.output === 'string',
      );
      assert.equal(expandedParts.map((unit) => unit.message.output).join(''), output);
      for (const unit of expandedParts)
        for (const key of ['exitCode', 'cancelled', 'truncated'])
          assert.equal(unit.message[key], message[key]);
      assert.equal(rows(captured, { query: command }).length, 1);
      assert.equal(rows(captured, { query: 'exit: 23; cancelled' }).length, 1);
      const text = documentText(captured, navigationDocuments(captured)[0]);
      assert.equal(
        text,
        `command: ${command}\nexit: 23; cancelled; native output truncated\n${output}`,
      );
    }
  });
}

test('brief and search retain assistant failure facts once across native and runtime split content', () => {
  for (const [stopReason, errorMessage, text] of [
    ['error', 'Upstream authentication failed', 'Partial response'],
    ['error', 'Upstream authentication failed', 'Partial response '.repeat(700)],
    ['aborted', undefined, 'Partial response '.repeat(700)],
  ]) {
    const message = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
    };
    const entries = [
      {
        type: 'message',
        id: 'task',
        parentId: null,
        message: { role: 'user', content: 'Inspect the deployment' },
      },
      { type: 'message', id: 'answer', parentId: 'task', message },
    ];
    const request = { session_id: 'fixture' };
    const native = prepareContextRead({ entries, leafId: 'answer' }, request, {
      buildSessionProjection,
    });
    const runtime = { units: [], accountedBytes: 0 };
    appendUnits(runtime, { type: 'assistant', source: { observation_index: 0 }, message });
    const query = errorMessage ?? 'assistant aborted';
    const found = prepareContextRead(
      { entries, leafId: 'answer' },
      { ...request, search_query: query },
      { buildSessionProjection },
    );
    assert.equal(rows(found, { query }).length, 1, 'Native acquisition retains failure evidence');
    for (const source of [native, runtime]) {
      const overview = rows(source).at(-1);
      assert.ok(overview.text.includes(`assistant ${stopReason}`));
      assert.equal(overview.text.split(`assistant ${stopReason}`).length - 1, 1);
      assert.match(overview.text, /Partial response/);
      if (errorMessage) assert.ok(overview.text.includes(errorMessage));
      const hits = rows(source, { query });
      assert.equal(hits.length, 1);
      assert.ok(hits[0].text.includes(query));
    }
  }
});

test('brief preserves image presence and shell commands remain searchable without output', () => {
  const target = { units: [], accountedBytes: 0 };
  appendUnits(target, {
    type: 'prompt',
    source: { entry_id: 'image-only' },
    message: {
      role: 'user',
      content: [{ type: 'image', mimeType: 'image/png', data: 'private-pixels' }],
    },
  });
  appendUnits(target, {
    type: 'command',
    source: { entry_id: 'shell-check' },
    message: {
      role: 'bashExecution',
      command: 'python scripts/verify_layout.py --check',
      output: '',
      exitCode: 1,
      cancelled: false,
      truncated: false,
    },
  });
  const snap = snapshot(target.units);
  const overview = rows(snap);
  assert.match(overview[0].text, /image.*image\/png/);
  assert.doesNotMatch(JSON.stringify(overview), /private-pixels/);
  assert.match(overview[1].text, /exit: 1/);
  const hits = rows(snap, { query: 'verify_layout' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'command');
  assert.match(hits[0].text, /python scripts\/verify_layout\.py --check/);
});

test('search filters before bounded capture and retains the complete matching logical tool pair', () => {
  const entries = [];
  const add = (role, content, fields = {}) => {
    const entry = {
      type: 'message',
      id: `entry-${entries.length}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role, content, timestamp: 0, ...fields },
    };
    entries.push(entry);
    return entry;
  };
  add('user', [{ type: 'text', text: 'Inspect the completed verification run.' }]);
  const irrelevantCode = 'x'.repeat(50 * 1024);
  const noiseCount = Math.ceil(READ_SNAPSHOT_LIMIT / (irrelevantCode.length * 4)) + 3;
  for (let i = 0; i < noiseCount; i++) {
    add('assistant', [
      {
        type: 'toolCall',
        id: `unrelated-${i}`,
        name: 'codemode',
        arguments: { code: irrelevantCode },
      },
      { type: 'text', text: `Unrelated progress record ${i}.` },
    ]);
    add('toolResult', [{ type: 'text', text: 'Unrelated output.' }], {
      toolCallId: `unrelated-${i}`,
      toolName: 'codemode',
      isError: false,
    });
  }
  const call = add('assistant', [
    {
      type: 'toolCall',
      id: 'target-call',
      name: 'read',
      arguments: { path: '/target/evidence.txt' },
    },
  ]);
  const result = add(
    'toolResult',
    [{ type: 'text', text: 'needle-verification: permission checks passed.' }],
    { toolCallId: 'target-call', toolName: 'read', isError: false },
  );
  const data = { header: { id: 'native-fixture' }, entries, leafId: result.id };
  const request = { session_id: identity.session_id, range: { recent: -1 }, content: ALL_CONTENT };
  const sdk = { buildSessionProjection };
  assert.throws(() => prepareContextRead(data, request, sdk), /READ_SNAPSHOT_TOO_LARGE/);
  const found = prepareContextRead(data, { ...request, search_query: 'needle-verification' }, sdk);
  assert.deepEqual(
    found.units.map((unit) => unit.type),
    ['tool_call', 'tool_result'],
  );
  assert.deepEqual(
    found.units.map((unit) => unit.source.entry_id),
    [call.id, result.id],
  );
  assert.equal(new Set(found.units.map((unit) => unit.tool_id)).size, 1);
  assert.ok(jsonBytes(found) < 4096);
  assert.doesNotMatch(JSON.stringify(found), /Unrelated/);
  const hits = rows(found, { query: 'needle-verification' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'tool');
});

test('runtime tool results retain their role and child navigation when nested calls split before the body', () => {
  const target = { units: [], accountedBytes: 0 };
  appendUnits(target, {
    type: 'tool_result',
    source: { observation_index: 2 },
    message: {
      role: 'toolResult',
      toolName: 'codemode',
      toolCallId: 'parent',
      isError: false,
      content: [{ type: 'text', text: 'Actual test summary: 35 passed.' }],
      nestedCalls: {
        complete: true,
        calls: [
          {
            id: 'one',
            name: 'run_tests',
            status: 'error',
            arguments: { code: 'irrelevant();'.repeat(300) },
            error: 'Assertion failed',
          },
        ],
      },
    },
  });
  assert.equal(target.units[0].type, 'nested_call');
  const snap = snapshot(target.units, { view: 'runtime' });
  const documents = navigationDocuments(snap);
  const overview = navigationRows(snap, documents, (i) => i);
  assert.equal(overview.length, 1);
  assert.equal(overview[0].type, 'tool');
  assert.equal(overview[0].title, 'codemode');
  assert.match(overview[0].text, /run_tests: error Assertion failed/);
  assert.doesNotMatch(overview[0].text, /Actual test summary: 35 passed/);
  assert.doesNotMatch(overview[0].text, /irrelevant/);
  const operation = overview[0].related.find((r) => r.relation === 'operation');
  assert.equal(documents[operation.ref].kind, 'tool');
  const hits = navigationRows(snap, documents, (i) => i, { query: 'Assertion failed' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].type, 'tool');
  assert.ok(hits[0].related.some((r) => r.relation === 'parent'));
});

test('runtime content switches preserve message block order and independent failure facts', () => {
  const runtime = {
    view: 'runtime',
    units: [],
    accountedBytes: 0,
    request: { content: { tool: 0 } },
  };
  appendUnits(runtime, {
    type: 'assistant',
    source: { observation_index: 0 },
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'First observation' },
        { type: 'thinking', thinking: 'Reconsider the constraint' },
        { type: 'text', text: 'Revised response' },
        {
          type: 'toolCall',
          id: 'hidden-call',
          name: 'bash',
          arguments: { command: 'private operation' },
        },
      ],
    },
  });
  const visible = rows(runtime);
  assert.deepEqual(
    visible.map((row) => row.type),
    ['assistant', 'thinking', 'assistant'],
  );
  assert.deepEqual(
    visible.map((row) => row.text),
    ['First observation', 'Reconsider the constraint', 'Revised response'],
  );
  assert.doesNotMatch(JSON.stringify(visible), /private operation/);
  const failed = {
    view: 'runtime',
    units: [],
    accountedBytes: 0,
    request: { content: { thinking: 0, tool: 0 } },
  };
  appendUnits(failed, {
    type: 'assistant',
    source: { observation_index: 1 },
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Unfinished investigation' }],
      stopReason: 'error',
      errorMessage: 'Provider unavailable',
    },
  });
  const failure = rows(failed);
  assert.equal(failure.length, 1);
  assert.equal(failure[0].type, 'assistant');
  assert.match(failure[0].text, /Provider unavailable/);
  assert.doesNotMatch(failure[0].text, /Unfinished investigation/);
});

test('message metadata joins its input reference without an empty navigation row', () => {
  const target = { units: [], accountedBytes: 0 };
  const body = 'A structured input\n  - preserve indentation\n'.repeat(150);
  appendUnits(target, {
    type: 'prompt',
    prompt_id: 'input',
    source: { entry_id: 'input', message_index: 0 },
    message: {
      role: 'user',
      timestamp: 123,
      content: [
        { type: 'text', text: body },
        { type: 'image', mimeType: 'image/png', data: 'omitted' },
      ],
    },
  });
  const snap = snapshot(target.units);
  const docs = navigationDocuments(snap),
    result = navigationRows(snap, docs, (index) => index);
  assert.equal(result.length, 1);
  assert.equal(result[0].type, 'input');
  assert.match(result[0].text, /\n  - preserve indentation/);
  assert.ok(docs[0].indices.some((index) => snap.units[index].type === 'message_metadata'));
  assert.match(documentText(snap, docs[0]), /image image\/png/);
});

test('adapter items expose related memory and source-boundary navigation without source body duplication', () => {
  const snap = snapshot(
    [
      {
        type: 'memory',
        text: 'Full memory evidence',
        preview: 'Condensed memory',
        source: { reader_item: 'memory-1' },
        provenance: { source_entry_id: 'end', source_relation: 'history_leaf' },
        related: [{ id: 'summary-1', relation: 'summary' }],
      },
      { type: 'summary', text: 'Summary', source: { reader_item: 'summary-1' } },
    ],
    { view: 'adapted' },
  );
  const documents = navigationDocuments(snap);
  const overview = navigationRows(snap, documents, (i) => i);
  assert.equal(overview.length, 2);
  assert.equal(overview[0].text, 'Condensed memory');
  const summary = overview[0].related.find((r) => r.relation === 'summary');
  assert.equal(documents[summary.ref].kind, 'summary');
  const source = overview[0].related.find((r) => r.relation === 'source_context');
  assert.equal(documents[source.ref].request.view, 'session');
  assert.equal(documents[source.ref].request.leaf_id, 'end');
  assert.equal(documents[source.ref].request.session_id, identity.session_id);
});

test('single-page references are retained, expand source content and enforce snapshot identity', () => {
  const cache = new ContextReadCache();
  const snap = snapshot([textUnit('a', 'Full source text', { preview: 'Short' })]);
  const page = cache.navigate(snap, args, { identity });
  assert.equal(page.next_cursor, null);
  assert.equal(page.items[0].text, 'Short');
  const ref = page.items[0].ref;
  assert.deepEqual(cache.referenceIdentity(ref), identity);
  assert.equal(cache.reference(ref).document.kind, 'assistant');
  const expanded = cache.expand([ref, ref], identity);
  assert.deepEqual(expanded.units, snap.units);
  assert.equal(expanded.navigation, undefined);
  assert.deepEqual(expanded.expanded_refs, [ref, ref]);
  assert.throws(
    () => cache.expand([ref], { ...identity, native_cwd: '/replacement' }),
    /INVALID_READ_REFERENCE/,
  );
  assert.throws(() => cache.reference('not-a-reference'), /INVALID_READ_REFERENCE/);
  const other = cache.navigate(snap, args, { identity });
  assert.throws(() => cache.expand([ref, other.items[0].ref], identity), /INVALID_READ_REFERENCE/);
});

test('evicted references fail clearly and an uncacheable overview never publishes references', () => {
  const cache = new ContextReadCache({ maxEntries: 1 });
  const snap = snapshot([textUnit('a', 'evidence')]);
  const first = cache.navigate(snap, args, { identity });
  const second = cache.navigate(snap, args, { identity });
  assert.throws(() => cache.reference(first.items[0].ref), /STALE_READ_REFERENCE/);
  assert.equal(cache.expand([second.items[0].ref], identity).units.length, 1);
  cache.clear();
  assert.throws(() => cache.reference(second.items[0].ref), /STALE_READ_REFERENCE/);
  const small = new ContextReadCache({ maxBytes: 1 });
  assert.throws(() => small.navigate(snap, args, { identity }), /READ_SNAPSHOT_TOO_LARGE/);
  assert.equal(small.entries.size, 0);
  assert.equal(small.accountedBytes, 0);
});

test('UTF-8 overview pages stay within the whole response budget and retain expandable references', () => {
  const cache = new ContextReadCache();
  const snap = snapshot(
    Array.from({ length: 4 }, (_, i) => textUnit(`unicode-${i}`, '决策与证据🔎'.repeat(800))),
  );
  let page = cache.navigate(snap, args, { identity });
  const refs = [];
  for (let count = 0; ; count++) {
    assert.ok(count < 10, 'pagination terminates');
    assert.ok(jsonBytes(page) <= args.max_bytes);
    assert.ok(page.items.length > 0);
    for (const item of page.items) {
      assert.ok(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(item.text),
      );
      refs.push(item.ref);
      assert.equal(cache.expand([item.ref], identity).units.length, 1);
    }
    if (!page.next_cursor) break;
    const captured = cache.get({ cursor: page.next_cursor }, identity);
    page = cache.render(
      captured.snapshot,
      { max_bytes: args.max_bytes },
      { ...captured, identity },
    );
  }
  assert.equal(new Set(refs).size, 4);
});

async function bridgeFixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-read-navigation-');
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd, { mode: 0o700 });
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: { ...denyAllPermissions(), read: true },
  };
  const bridge = await new Bridge(config, () => assert.fail('Read must not start a writer')).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const made = await savedSession(bridge);
  const session = await bridge.session(made.session_id);
  const entries = [
    {
      type: 'message',
      id: 'u',
      parentId: null,
      message: { role: 'user', content: [{ type: 'text', text: 'Find the permission decision' }] },
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
            text: 'start '.repeat(500) + 'A unique middle decision' + ' end'.repeat(700),
          },
        ],
      },
    },
    {
      type: 'message',
      id: 'u2',
      parentId: 'a',
      message: { role: 'user', content: [{ type: 'text', text: 'Current task' }] },
    },
    {
      type: 'message',
      id: 'a2',
      parentId: 'u2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Current progress' }] },
    },
  ];
  let acquisitions = 0;
  bridge.pool.forRead = async () => ({
    generation: 'fixture',
    read: async (args) => {
      acquisitions++;
      return prepareContextRead({ entries, leafId: 'a2' }, args, { buildSessionProjection });
    },
  });
  return {
    bridge,
    config,
    session,
    entries,
    id: made.session_id,
    acquisitions: () => acquisitions,
  };
}

test('Bridge search finds older effective content, expands frozen evidence and rechecks current permission', async (t) => {
  const f = await bridgeFixture(t);
  await assert.rejects(
    f.bridge.read({ session_id: f.id, search_query: 'unique middle decision' }),
    /INVALID_READ_ARGUMENTS/,
  );
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
  f.config.defaults.read = false;
  await assert.rejects(f.bridge.read({ refs }), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.acquisitions(), 2);
});

for (const paired of [false, true]) {
  test(`Bridge search preserves continuous tool output across source parts (${paired ? 'paired' : 'orphan'})`, async (t) => {
    const f = await bridgeFixture(t);
    f.bridge.pool.forRead = async () => null;
    const body = Array.from(
      { length: 350 },
      (_, i) =>
        `Entry ${String(i).padStart(4, '0')}: a distinct diagnostic observation for the investigation.`,
    ).join(' ');
    const entries = [
      {
        type: 'message',
        id: 'task',
        parentId: null,
        message: { role: 'user', content: 'Inspect the diagnostic evidence.' },
      },
      ...(paired
        ? [
            {
              type: 'message',
              id: 'call',
              parentId: 'task',
              message: {
                role: 'assistant',
                content: [
                  { type: 'toolCall', id: 'diagnostic-call', name: 'special_tool', arguments: {} },
                ],
              },
            },
          ]
        : []),
      {
        type: 'message',
        id: 'result',
        parentId: paired ? 'call' : 'task',
        message: {
          role: 'toolResult',
          toolCallId: 'diagnostic-call',
          toolName: 'special_tool',
          isError: false,
          content: [{ type: 'text', text: body }],
        },
      },
    ];
    await fs.writeFile(
      f.session.file,
      [f.session.header, ...entries].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
    );
    let page = await f.bridge.read({
      session_id: f.id,
      view: 'session',
      range: { recent: -1 },
      content: ALL_CONTENT,
      max_bytes: 4096,
    });
    const tool = page.items.find((item) => item.type === 'tool');
    page = await f.bridge.read({ refs: [tool.ref], max_bytes: 4096 });
    let boundary;
    while (boundary === undefined) {
      for (const item of page.items) {
        if (item.message?.role !== 'toolResult') continue;
        const fragment = item.message.content?.find((block) => block.type === 'text')?.text;
        if (!fragment) continue;
        const start = body.indexOf(fragment);
        const end = start + fragment.length;
        if (start >= 0 && end > 40 && end < body.length - 40) boundary = end;
      }
      if (boundary !== undefined || !page.next_cursor) break;
      page = await f.bridge.read({ cursor: page.next_cursor, max_bytes: 4096 });
    }
    assert.ok(boundary !== undefined, 'long output has a source-part boundary');
    // Derive the query from the original output around an observed boundary,
    // without depending on the splitter's target size or text reconstruction.
    const phrase = body.slice(boundary - 40, boundary + 40);
    assert.ok(body.includes(phrase));
    const found = await f.bridge.search({ session_id: f.id, query: phrase });
    assert.equal(found.matches, 1);
    assert.ok(found.items[0].text.includes(phrase));
    const named = await f.bridge.search({ session_id: f.id, query: 'special_tool' });
    assert.equal(named.matches, 1);
    assert.equal(named.items[0].title, 'special_tool');
  });
}

test('Bridge reference expansion rejects a changed native cwd without reacquiring content', async (t) => {
  const f = await bridgeFixture(t);
  const page = await f.bridge.read({ session_id: f.id });
  const other = path.join(path.dirname(f.session.cwd), 'replacement');
  await fs.mkdir(other);
  const lines = (await fs.readFile(f.session.file, 'utf8')).trimEnd().split('\n');
  lines[0] = JSON.stringify({ ...JSON.parse(lines[0]), cwd: other });
  await fs.writeFile(f.session.file, lines.join('\n') + '\n');
  await assert.rejects(f.bridge.read({ refs: [page.items[0].ref] }), /INVALID_READ_REFERENCE/);
  assert.equal(f.acquisitions(), 1);
});

test('read/search schemas and MCP discovery describe a usable navigation path', () => {
  assert.ok(readSchema.safeParse({ refs: ['opaque-ref'] }).success);
  assert.ok(!readSchema.safeParse({ refs: ['opaque-ref'], detail: 'full' }).success);
  assert.ok(
    !readSchema.safeParse({ session_id: 's', view: 'runtime', range: { recent: 1 } }).success,
  );
  assert.ok(!searchSchema.safeParse({ session_id: 's', query: ' ' }).success);
  assert.ok(
    searchSchema.safeParse({
      session_id: 's',
      view: 'runtime',
      query: 'failure',
      content: ['tool'],
    }).success,
  );
  const tools = toolDefinitions();
  const read = tools.find((tool) => tool.name === 'read');
  const search = tools.find((tool) => tool.name === 'search');
  assert.ok(search, 'search is discoverable without knowing a hidden Bridge method');
  assert.ok(search.inputSchema.properties.query);
  assert.ok(read.inputSchema.properties.refs);
  assert.match(read.description, /ref/i);
  assert.match(search.description, /read|ref/i);
});
