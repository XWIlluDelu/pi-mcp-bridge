import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs/promises';
import { SessionManager, fauxAssistantMessage } from './fixtures/pi.mjs';
import { SettledObserver } from '../src/events/settled-observer.mjs';
import { ownerSocket } from '../src/owner-runtime.mjs';
import { hash } from '../src/core/storage.mjs';
import {
  captureSettledResult,
  SETTLED_RESULT_LIMIT,
  settledResultSchema,
} from '../src/events/settled-result.mjs';
import { Submissions } from '../src/core/submissions.mjs';

test(
  'settlement freezes its boundary and an unresponsive Bridge does not block later local work',
  { timeout: 8000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-settled-observer-');
    const control = { stateDir: dir, attachmentDir: dir };
    const connections = new Set(),
      requests = [];
    const server = net.createServer({ allowHalfOpen: true }, (connection) => {
      connections.add(connection);
      connection.on('error', () => {});
      connection.on('close', () => connections.delete(connection));
      let body = '';
      connection.on('data', (chunk) => {
        body += chunk;
      });
      connection.on('end', () => {
        requests.push(JSON.parse(body));
        // The first request stalls; the next demonstrates normal recovery without
        // replaying the lost occurrence or retaining a background sender.
        if (requests.length > 1) connection.end(JSON.stringify({ data: {} }) + '\n');
      });
    });
    await new Promise((resolve) => server.listen(ownerSocket(control), resolve));
    t.after(async () => {
      for (const connection of connections) connection.destroy();
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(dir, { recursive: true, force: true });
    });
    const manager = SessionManager.create(dir, dir);
    const observer = new SettledObserver(control, 'test-generation');
    observer.start(manager);
    manager.appendMessage(fauxAssistantMessage('FIRST_RESULT'));
    const first = observer.capture({ aborted: false }, manager);
    const started = Date.now();
    const sending = observer.send(first);
    manager.appendMessage(fauxAssistantMessage('LATER_RESULT'));
    await sending;
    assert.ok(Date.now() - started < 5000, 'The local IPC deadline must bound the wait');
    assert.equal(requests[0].leafId, first.leafId);
    assert.equal(requests[0].sessionCwdHash, hash(manager.getHeader().cwd));
    assert.equal(requests[0].result.text, 'FIRST_RESULT');
    assert.notEqual(requests[0].leafId, manager.getLeafId());

    // No observed start means no result, even though history has a recent answer.
    const next = observer.capture({ aborted: true }, manager);
    await observer.send(next);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].result, null);
    assert.equal(requests[1].aborted, true);
    assert.ok(requests[1].sequence > requests[0].sequence);
  },
);

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

test('settlement requires a run boundary in the effective branch', () => {
  const session = manager(),
    forkPoint = user(session, 'Common task');
  const previous = assistant(session, 'OFF_BRANCH_REPORT');
  session.branch(forkPoint);
  const boundary = user(session, 'Current task');
  for (const id of [undefined, previous, boundary, 'missing-boundary'])
    assert.equal(captureSettledResult(session, id), null);
  const entry = assistant(session, 'RAW_DRAFT');
  session.appendContextEdit(entry, { content: [{ type: 'text', text: 'AMENDED_REPORT' }] });
  const result = valid(captureSettledResult(session, boundary));
  assert.deepEqual(result, {
    entry_id: entry,
    text: 'AMENDED_REPORT',
    stop_reason: 'stop',
    truncated: false,
  });
  session.appendContextEdit(entry, null);
  assert.equal(captureSettledResult(session, boundary), null);
  assert.equal(result.text, 'AMENDED_REPORT');
  assert.equal(session.getEntry(entry).message.content[0].text, 'RAW_DRAFT');
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

test('submission observations have independent identities and retain only admission metadata', () => {
  const submissions = new Submissions();
  const first = submissions.start('session-a', 'send');
  const second = submissions.start('session-a', 'send');
  assert.notEqual(first, second);
  submissions.update(first, {
    status: 'dispatched',
    admission: 'unobservable',
    text: 'PRIVATE_INPUT',
    images: ['PRIVATE_IMAGE'],
  });
  const record = submissions.get('session-a', first);
  assert.deepEqual(record.receipt, { status: 'dispatched', admission: 'unobservable' });
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_/);
  record.receipt.status = 'modified-by-caller';
  assert.equal(submissions.get('session-a', first).receipt.status, 'dispatched');
  assert.equal(submissions.get('session-a', second).receipt.status, 'pending');
  assert.throws(() => submissions.get('session-b', first), /SUBMISSION_UNAVAILABLE/);
});

for (const reason of ['expiry', 'eviction'])
  test(`a late ACK cannot recreate a submission lost to ${reason}`, () => {
    let time = 0;
    const submissions = new Submissions({ now: () => time, ttl: 100, limit: 2 });
    const first = submissions.start('session-a', 'create');
    submissions.update(first, { status: 'unknown', reason: 'ACK_TIMEOUT' });
    if (reason === 'expiry') time = 100;
    else {
      submissions.start('session-b', 'send');
      submissions.start('session-a', 'send');
    }
    assert.throws(() => submissions.get('session-a', first), /SUBMISSION_UNAVAILABLE/);
    assert.equal(submissions.update(first, { status: 'started' }), null);
  });
