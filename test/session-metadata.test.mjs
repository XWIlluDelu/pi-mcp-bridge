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

test('live status, model and capability reports are sanitized independently of idle certainty', async () => {
  const model = { provider: 'p', id: 'm', apiKey: 'SECRET' };
  const status = async (runtime) =>
    (await runtimeMetadata({ forRead: async () => runtime }, { model })).status;
  const companion = (state) => ({ attached: true, record: { kind: 'extension' }, state });
  for (const [observed, expected] of [
    [{ activity: { idle: true } }, 'idle'],
    [{ activity: { pending_messages: true } }, 'busy'],
    [{}, 'unknown'],
  ]) {
    const value = await status(companion(() => ({ ...observed, model, thinkingLevel: 'xhigh' })));
    assert.equal(value.state, expected);
    assert.deepEqual(value.model, { provider: 'p', id: 'm' });
    assert.equal(value.thinking_level, 'xhigh');
    assert.equal(value.capabilities.stop, false);
  }
  const owned = await status({
    hasUnsettledWork: () => true,
    idleSnapshot: () => ({ state: { pendingMessageCount: 0 }, status: 'unconfirmed' }),
  });
  assert.equal(owned.state, 'busy');
  assert.equal(owned.pending_messages, 0);
  assert.equal(owned.capabilities.stop, true);
  assert.equal((await status(null)).state, 'saved');
  const unavailable = await status(
    companion(() => {
      throw Error('SECRET');
    }),
  );
  assert.equal(unavailable.state, 'unavailable');
  assert.equal(unavailable.model, null);
  assert.equal(unavailable.capabilities, undefined);
});
