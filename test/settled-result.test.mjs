import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager, fauxAssistantMessage } from './fixtures/pi.mjs';
import {
  captureSettledResult,
  SETTLED_RESULT_LIMIT,
  settledResultSchema,
} from '../src/settled-result.mjs';

const manager = () => SessionManager.inMemory('/tmp/settled-result-in-memory');
const user = (session, text = 'Current task') =>
  session.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
const assistant = (session, text, extra = {}) =>
  session.appendMessage({ ...fauxAssistantMessage(text), ...extra });
function valid(result) {
  assert.equal(settledResultSchema.safeParse(result).success, true, JSON.stringify(result));
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= SETTLED_RESULT_LIMIT);
  return result;
}

test('settlement requires a known run boundary and never borrows the previous answer', () => {
  const session = manager();
  user(session, 'Old task');
  const previous = assistant(session, 'OLD_SUCCESS_REPORT');
  assert.equal(captureSettledResult(session, undefined), null);
  user(session, 'Aborted before producing output');
  assert.equal(captureSettledResult(session, previous), null);
  assert.equal(captureSettledResult(session, 'missing-boundary'), null);
  const current = assistant(session, 'NEW_REPORT');
  assert.deepEqual(valid(captureSettledResult(session, previous)), {
    entry_id: current,
    text: 'NEW_REPORT',
    stop_reason: 'stop',
    truncated: false,
  });
  assert.equal(captureSettledResult(session, current), null);
});

test('an explicit null boundary supports the first run and an empty session has no result', () => {
  const session = manager();
  assert.equal(captureSettledResult(session, null), null);
  user(session);
  const entry = assistant(session, 'FIRST_REPORT');
  assert.deepEqual(valid(captureSettledResult(session, null)), {
    entry_id: entry,
    text: 'FIRST_REPORT',
    stop_reason: 'stop',
    truncated: false,
  });
});

test('settlement reads native projected amendments and respects context-hidden output', () => {
  const session = manager();
  const baseline = user(session);
  const entry = assistant(session, 'RAW_DRAFT_SHOULD_NOT_BE_SENT');
  session.appendContextEdit(entry, { content: [{ type: 'text', text: 'AMENDED_REPORT' }] });
  const result = valid(captureSettledResult(session, baseline));
  assert.equal(result.entry_id, entry);
  assert.equal(result.text, 'AMENDED_REPORT');
  assert.equal(JSON.stringify(result).includes('RAW_DRAFT'), false);
  assert.equal(session.getEntry(entry).message.content[0].text, 'RAW_DRAFT_SHOULD_NOT_BE_SENT');
  session.appendContextEdit(entry, null);
  assert.equal(captureSettledResult(session, baseline), null);
});

test('a hidden old assistant cannot be revived by an edit in the current run', () => {
  const session = manager();
  const old = assistant(session, 'OLD_REPORT');
  session.appendContextEdit(old, null);
  const baseline = user(session, 'New task without model output');
  session.appendContextEdit(old, { content: [{ type: 'text', text: 'EDITED_OLD_REPORT' }] });
  assert.equal(captureSettledResult(session, baseline), null);
});

test('a different branch cannot reuse a missing run boundary or off-branch report', () => {
  const session = manager();
  const forkPoint = user(session, 'Common task');
  const offBranch = assistant(session, 'OFF_BRANCH_REPORT');
  session.branch(forkPoint);
  const current = assistant(session, 'CURRENT_BRANCH_REPORT');
  assert.equal(captureSettledResult(session, offBranch), null);
  assert.equal(valid(captureSettledResult(session, forkPoint)).entry_id, current);
});

test('the last empty error response does not fall back to an earlier successful-looking message', () => {
  const session = manager();
  const baseline = user(session);
  assistant(session, 'EARLIER_PROGRESS_LOOKS_SUCCESSFUL');
  const error = assistant(session, '', {
    content: [],
    stopReason: 'error',
    errorMessage: 'PRIVATE_PROVIDER_ERROR_DETAIL',
  });
  assert.deepEqual(valid(captureSettledResult(session, baseline)), {
    entry_id: error,
    text: '',
    stop_reason: 'error',
    truncated: false,
  });
});

test('only text from the last assistant is included; thinking, tool arguments and results stay out', () => {
  const session = manager();
  const baseline = user(session);
  const entry = assistant(session, '', {
    content: [
      { type: 'thinking', thinking: 'PRIVATE_THINKING' },
      { type: 'text', text: 'VISIBLE_START' },
      { type: 'toolCall', id: 'tool-1', name: 'bash', arguments: { command: 'PRIVATE_ARGS' } },
      { type: 'text', text: 'VISIBLE_END' },
    ],
    stopReason: 'toolUse',
  });
  session.appendMessage({
    role: 'toolResult',
    toolCallId: 'tool-1',
    toolName: 'bash',
    content: [{ type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }],
    isError: false,
    timestamp: Date.now(),
  });
  const result = valid(captureSettledResult(session, baseline));
  assert.equal(result.entry_id, entry);
  assert.equal(result.stop_reason, 'toolUse');
  assert.ok(result.text.startsWith('VISIBLE_START'));
  assert.ok(result.text.endsWith('VISIBLE_END'));
  assert.equal(JSON.stringify(result).includes('PRIVATE_'), false);
});

test('unknown stop reason remains unclaimed and empty text remains an actual empty result', () => {
  const session = manager();
  const baseline = user(session);
  const message = fauxAssistantMessage('');
  delete message.stopReason;
  const entry = session.appendMessage(message);
  assert.deepEqual(valid(captureSettledResult(session, baseline)), {
    entry_id: entry,
    text: '',
    stop_reason: null,
    truncated: false,
  });
});

test('large Unicode and JSON-escaped responses retain both ends within the byte budget', () => {
  for (const middle of ['中文结果😀🚀'.repeat(2000), '\u0000"\\\n'.repeat(5000)]) {
    const session = manager();
    const baseline = user(session);
    assistant(session, `HEAD_RESULT\n${middle}\nTAIL_ARTIFACT [report](./report.md)`);
    const result = valid(captureSettledResult(session, baseline));
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 2048);
    assert.ok(result.text.startsWith('HEAD_RESULT'));
    assert.ok(result.text.endsWith('TAIL_ARTIFACT [report](./report.md)'));
    assert.equal(result.text.isWellFormed(), true);
  }
});

test('a captured result is detached from later rounds and amendments', () => {
  const session = manager();
  const baseline = user(session);
  const entry = assistant(session, 'FIRST_REPORT');
  const result = valid(captureSettledResult(session, baseline));
  const before = JSON.stringify(result);
  user(session, 'Second task');
  assistant(session, 'SECOND_REPORT');
  session.appendContextEdit(entry, { content: [{ type: 'text', text: 'CHANGED_FIRST_REPORT' }] });
  assert.equal(JSON.stringify(result), before);
  assert.equal(result.text, 'FIRST_REPORT');
});
