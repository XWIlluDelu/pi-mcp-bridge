import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { savedSessionName, runtimeMetadata } from '../src/session-metadata.mjs';
import { readSessionIdentity } from '../src/data.mjs';
import { AttachedRuntime } from '../src/attachments.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';

test('title cache reuses only unchanged files; append, incomplete record, truncation and replacement invalidate', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-metadata-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl'),
    cache = new Map();
  const header = JSON.stringify({ type: 'session', id: 'test', cwd: dir }) + '\n';
  const title = (name) => JSON.stringify({ type: 'session_info', name }) + '\n';
  const readName = async () => savedSessionName(await readSessionIdentity(file), cache);
  await fs.writeFile(file, header + title('first'));
  assert.equal(await readName(), 'first');
  await fs.appendFile(file, '{"type":"session_info","name":"se');
  assert.equal(await readName(), 'first');
  await fs.appendFile(file, 'cond"}\n');
  assert.equal(await readName(), 'second');
  await fs.writeFile(file, header + title('tiny'));
  const row = await readSessionIdentity(file);
  const replacement = file + '.new';
  await fs.writeFile(replacement, header + title('swap'));
  await fs.rename(replacement, file);
  assert.equal(await savedSessionName(row, cache), null);
  assert.equal(await readName(), 'swap');
});

test('live status, model and capability reports are sanitized independently of idle certainty', async () => {
  const model = { provider: 'p', id: 'm', apiKey: 'SECRET' };
  const status = async (runtime) =>
    (await runtimeMetadata({ forRead: async () => runtime }, { model })).status;
  const companion = (state) =>
    Object.assign(new AttachedRuntime({}, {}, { kind: 'extension' }), { state });
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
  const owned = await status(
    ownedRuntime({
      hasUnsettledWork: () => true,
      state: () => ({ pendingMessageCount: 0 }),
    }),
  );
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
