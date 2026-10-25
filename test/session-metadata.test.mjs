import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionMetadata, runtimeMetadata } from '../src/session-metadata.mjs';

test('title cache reuses only unchanged files; append, incomplete record, truncation and replacement invalidate', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-metadata-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const session = { file: path.join(dir, 'session.jsonl') },
    cache = new Map();
  const title = (name) => JSON.stringify({ type: 'session_info', name }) + '\n';
  await fs.writeFile(session.file, title('first'));
  const first = await sessionMetadata(session, cache);
  assert.strictEqual(await sessionMetadata(session, cache), first);
  await fs.appendFile(session.file, '{"type":"session_info","name":"se');
  assert.equal((await sessionMetadata(session, cache)).name, 'first');
  await fs.appendFile(session.file, 'cond"}\n');
  assert.equal((await sessionMetadata(session, cache)).name, 'second');
  await fs.writeFile(session.file, title('tiny'));
  assert.equal((await sessionMetadata(session, cache)).name, 'tiny');
  const before = await fs.stat(session.file),
    temp = session.file + '.new';
  await fs.writeFile(temp, title('swap'));
  await fs.utimes(temp, before.atime, before.mtime);
  await fs.rename(temp, session.file);
  assert.equal((await sessionMetadata(session, cache)).name, 'swap');
  await fs.unlink(session.file);
  await assert.rejects(sessionMetadata(session, cache), { code: 'ENOENT' });
});

test('title cache has a fixed retention bound and never retains history', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-metadata-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cache = new Map();
  for (let i = 0; i < 260; i++) {
    const file = path.join(dir, i + '.jsonl');
    await fs.writeFile(
      file,
      JSON.stringify({ type: 'message', content: 'NOT_A_TITLE' }) +
        '\n' +
        JSON.stringify({ type: 'session_info', name: String(i) }) +
        '\n',
    );
    await sessionMetadata({ file }, cache);
  }
  assert.equal(cache.size, 256);
  assert.equal(cache.has(path.join(dir, '0.jsonl')), false);
  assert.equal(JSON.stringify([...cache]).includes('NOT_A_TITLE'), false);
});

test('list model/thinking metadata comes only from live state, independently of idle certainty', async () => {
  const model = {
    provider: 'p',
    id: 'm',
    headers: { Authorization: 'SECRET' },
    apiKey: 'SECRET',
    baseUrl: 'SECRET',
  };
  for (const [runtime, expectedState] of [
    [{ state: async () => ({ model, thinkingLevel: 'xhigh', isIdle: true }) }, 'idle'],
    [{ state: async () => ({ model, thinkingLevel: 'xhigh' }) }, 'unknown'],
    [
      {
        attached: true,
        record: { kind: 'extension' },
        state: async () => ({ model, thinkingLevel: 'xhigh', activity: { idle: false } }),
      },
      'busy',
    ],
  ]) {
    const { status } = await runtimeMetadata({ forRead: async () => runtime }, {});
    assert.equal(status.state, expectedState);
    assert.deepEqual(status.model, { provider: 'p', id: 'm' });
    assert.equal(status.thinking_level, 'xhigh');
    assert.ok(!JSON.stringify(status).includes('SECRET'));
  }
  for (const [runtime, expectedState] of [
    [null, 'saved'],
    [
      {
        state: async () => {
          throw Error('UNREACHABLE');
        },
      },
      'unavailable',
    ],
    [{ state: async () => ({}) }, 'unknown'],
    [
      { state: async () => ({ model: { provider: 1, id: 'm' }, thinkingLevel: 'invalid' }) },
      'unknown',
    ],
  ]) {
    const { status } = await runtimeMetadata(
      { forRead: async () => runtime },
      { model, thinkingLevel: 'high' },
    );
    assert.equal(status.state, expectedState);
    assert.equal(status.model, null);
    assert.equal(status.thinking_level, null);
    if (runtime === null || expectedState === 'unavailable')
      assert.equal(Object.hasOwn(status, 'capabilities'), false);
  }
});

test('runtime capabilities stay supported across busy and unknown activity observations', async () => {
  for (const [state, expected, count] of [
    [{ isStreaming: false, activity: { idle: true, pending_message_count: 0 } }, 'idle', 0],
    [{ isStreaming: false, activity: { idle: true, pending_messages: true } }, 'busy', null],
    [{ isStreaming: false, activity: { idle: false } }, 'busy', null],
    [{ isStreaming: false, isCompacting: false, pendingMessageCount: 0 }, 'unknown', 0],
    [{ isStreaming: false, pendingMessageCount: -1 }, 'unknown', null],
  ]) {
    const { status: result } = await runtimeMetadata(
      {
        forRead: async () => ({
          state: async () => state,
          command() {},
          executeBash() {},
          stopExecution() {},
        }),
      },
      {},
    );
    assert.equal(result.state, expected);
    assert.equal(result.pending_messages, count);
    assert.deepEqual(result.capabilities, { send: true, reload: false, command: true, stop: true });
  }
});
