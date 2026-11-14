import { message, text } from './fixtures/native-history.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { Bridge } from '../src/bridge.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { SessionManager } from './fixtures/pi.mjs';
import { loadSession, readSessionIdentity } from '../src/data.mjs';

test('discarded broken branches do not block native current context; traversed cycles and duplicate IDs reject', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-history-branch-');
  await fs.mkdir(dir + '/sessions', { mode: 0o700 });
  const file = dir + '/sessions/history.jsonl';
  const rows = [
    { type: 'session', version: 3, id: 'partial-tree', cwd: dir },
    message('root', null, 'user', 'ROOT'),
    message('discarded', 'missing', 'assistant', [text('DISCARDED')]),
    message('cycle-a', 'cycle-b', 'user', 'CYCLE_A'),
    message('cycle-b', 'cycle-a', 'assistant', [text('CYCLE_B')]),
    message('current', 'root', 'user', 'CURRENT'),
    message('answer', 'current', 'assistant', [text('ANSWER')]),
  ];
  const bytes = rows.map(JSON.stringify).join('\n') + '\n{"torn":\n';
  await fs.writeFile(file, bytes);
  const bridge = await new Bridge({
    stateDir: dir + '/state',
    sessionRoots: [dir + '/sessions'],
    folders: [],
    defaults: { ...denyAllPermissions(), read: true },
  }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const native = SessionManager.open(file); // Use only an already LF-terminated v3 file.
  assert.deepEqual(
    native.getBranch().map((e) => e.id),
    ['root', 'current', 'answer'],
  );
  const id = (await readSessionIdentity(file)).id;
  const read = await bridge.read({ session_id: id, range: { recent: -1 }, content: ALL_CONTENT });
  assert.ok(JSON.stringify(read.items).includes('CURRENT'));
  assert.ok(JSON.stringify(read.items).includes('ANSWER'));
  assert.ok(!JSON.stringify(read.items).includes('DISCARDED'));
  assert.equal(read.history.skipped_malformed_lines, 1);
  assert.equal(await fs.readFile(file, 'utf8'), bytes);
  await assert.rejects(
    bridge.read({
      session_id: id,
      leaf_id: 'cycle-a',
      range: { recent: -1 },
      content: ALL_CONTENT,
    }),
    /INVALID_SESSION_TREE/,
  );
  await fs.writeFile(file, rows.concat(rows.at(-1)).map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(loadSession(file), /INVALID_SESSION_TREE/);
  const cyclic = structuredClone(rows);
  cyclic.at(-1).parentId = 'answer';
  await fs.writeFile(file, cyclic.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(loadSession(file), /INVALID_SESSION_TREE/);
});

test('current Pi can reopen a raw fork without changing the source', async (t) => {
  const f = await nativeOwner(t);
  const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' };
  const rows = [
    message('u', null, 'user', [text('source task'), image]),
    message('a', 'u', 'assistant', [text('source answer')]),
    {
      type: 'compaction',
      id: 'c',
      parentId: 'a',
      summary: 'source summary',
      tokensBefore: 100,
      firstKeptEntryId: 'a',
    },
    { type: 'label', id: 'l', parentId: 'c', targetId: 'u', label: 'source bookmark' },
  ];
  await fs.appendFile(f.session.file, rows.map(JSON.stringify).join('\n') + '\n{"torn":');
  const before = await fs.readFile(f.session.file);
  const history = await f.bridge.read({ session_id: f.id, content: ALL_CONTENT });
  assert.equal(history.history.unterminated_tail, true);
  assert.equal(history.history.skipped_malformed_lines, 1);
  const fork = await f.bridge.create({ project: f.cwd, fork_from: f.id });
  assert.equal(fork.status, 'created', JSON.stringify(fork));
  const child = await f.bridge.session(fork.session_id);
  const manager = SessionManager.open(child.file);
  const entries = manager.getEntries();
  const first = entries.find((entry) => entry.message?.role === 'user');
  assert.deepEqual(first.message.content[1], image);
  assert.equal(manager.getLabel(first.id), 'source bookmark');
  const compact = entries.find((entry) => entry.type === 'compaction');
  const kept = entries.find((entry) => entry.id === compact.firstKeptEntryId);
  assert.equal(kept.message.content[0].text, 'source answer');
  assert.notEqual(manager.getSessionId(), f.session.header.id);
  assert.deepEqual(await fs.readFile(f.session.file), before);
});
