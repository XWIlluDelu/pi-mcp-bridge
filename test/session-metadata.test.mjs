import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sessionMetadata, runtimeStatus } from '../src/session-metadata.mjs';

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

test('runtime status uses companion idle evidence but does not infer native RPC idle from no streaming', async () => {
  for (const [state, expected, count] of [
    [{ isStreaming: false, activity: { idle: true, pending_message_count: 0 } }, 'idle', 0],
    [{ isStreaming: false, activity: { idle: true, pending_messages: true } }, 'busy', null],
    [{ isStreaming: false, activity: { idle: false } }, 'busy', null],
    [{ isStreaming: false, isCompacting: false, pendingMessageCount: 0 }, 'unknown', 0],
    [{ isStreaming: false, pendingMessageCount: -1 }, 'unknown', null],
  ]) {
    const result = await runtimeStatus({ forRead: async () => ({ state: async () => state }) }, {});
    assert.equal(result.state, expected);
    assert.equal(result.pending_messages, count);
  }
});
