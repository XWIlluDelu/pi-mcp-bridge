import { nativeOwner } from './fixtures/native-owner.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { loadSession, readSessionIdentity, discover } from '../src/core/data.mjs';

async function fixture(t) {
  let starts = 0;
  const runtime = ownedRuntime({
    alive: true,
    command: async () => ({ disposition: 'started' }),
    stop: async () => {
      runtime.alive = false;
    },
    state: async () => ({ isStreaming: false, isCompacting: false }),
  });
  const f = await nativeOwner(t, {
    prefix: 'discovery',
    factory: async () => {
      starts++;
      return runtime;
    },
  });
  return { ...f, runtime, starts: () => starts };
}
test('warm known-ID lookup and listing avoid discovery but revalidate identity and current permissions', async (t) => {
  const f = await fixture(t);
  await f.bridge.list({ session_id: f.session.id });
  let scans = 0;
  const discover = f.bridge.sessions.bind(f.bridge);
  t.mock.method(f.bridge, 'sessions', async () => {
    scans++;
    return discover();
  });
  assert.equal((await f.bridge.session(f.session.id)).id, f.session.id);
  assert.equal((await f.bridge.list({ session_id: f.session.id })).sessions.length, 1);
  assert.equal(scans, 0);
  const header = { ...f.session.header, cwd: '/unavailable' };
  await fs.writeFile(f.session.file, JSON.stringify(header) + '\n');
  const moved = await f.bridge.session(f.session.id);
  assert.equal(moved.cwd, '/unavailable');
  assert.deepEqual((await f.bridge.list({ session_id: f.session.id })).sessions, []);
  assert.equal(scans, 0);
  await fs.writeFile(f.session.file, JSON.stringify({ ...header, id: 'replacement' }) + '\n');
  await assert.rejects(f.bridge.session(f.session.id), /NOT_FOUND_OR_DENIED/);
  assert.equal(scans, 1);
  const replacement = (await f.bridge.sessions())[0];
  assert.notEqual(replacement.id, f.session.id);
  await fs.unlink(f.session.file);
  await assert.rejects(f.bridge.session(replacement.id), /NOT_FOUND_OR_DENIED/);
});

test('identity discovery ignores unrelated transcript bodies, content parse follows authorization', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.session.file, 'not JSON at all\n');
  assert.equal((await discover(f.config))[0].id, f.session.id);
  f.config.grants = [{ session_id: f.session.id, read: false, delete: true }];
  assert.deepEqual((await f.bridge.list()).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: f.session.id }), /NOT_FOUND_OR_DENIED/);
  f.config.grants.push({ session_id: f.session.id, list: true, read: true, send: true });
  const before = await fs.readFile(f.session.file, 'utf8'),
    read = await f.bridge.read({ session_id: f.session.id });
  assert.equal(read.history.skipped_malformed_lines, 1);
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, text: 'fixture' })).status,
    'started',
  );
  assert.equal(f.starts(), 1);
  assert.equal(await fs.readFile(f.session.file, 'utf8'), before);
  const other = await f.bridge.create({
    project: f.cwd,
    text: 'first',
  });
  assert.equal(other.status, 'rejected');
  assert.equal((await f.bridge.delete({ session_id: f.session.id })).status, 'deleted');
});
test('missing cwd retains project history and deletion rights without permitting a new writer', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(
    f.session.file,
    JSON.stringify({
      type: 'message',
      id: 'saved-input',
      parentId: null,
      message: { role: 'user', content: 'preserved workspace history' },
    }) + '\n',
  );
  const previous = await f.bridge.read({ session_id: f.session.id });
  assert.match(JSON.stringify(previous.items), /preserved workspace history/);
  await fs.rename(f.cwd, f.cwd + '-moved');
  const identity = await readSessionIdentity(f.session.file);
  assert.equal(identity.cwd, f.cwd);
  assert.equal(identity.header.cwd, f.cwd);
  assert.equal((await f.bridge.list()).sessions[0].session_id, f.session.id);
  assert.deepEqual(
    (await f.bridge.read({ session_id: f.session.id })).items.map(({ ref, ...item }) => item),
    previous.items.map(({ ref, ...item }) => item),
  );
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, text: 'fixture' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal(f.starts(), 0);
  assert.equal(
    (await f.bridge.create({ project: f.cwd, text: 'first' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal((await fs.readdir(f.config.sessionRoots[0])).length, 1);
  const deleted = await f.bridge.delete({ session_id: f.session.id });
  assert.equal(deleted.status, 'deleted');
  assert.equal(deleted.project, f.cwd);
});
test('existing owned runtime retains project-authorized control after cwd disappears', async (t) => {
  const f = await fixture(t);
  await f.bridge.send({ session_id: f.session.id, text: 'fixture' });
  await fs.rename(f.cwd, f.cwd + '-moved');
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (await f.bridge.send({ session_id: f.session.id, text: 'fixture' })).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal(f.starts(), 1);
});
test('file replacement refuses cold execution while symlinked project directory stays usable under recorded identity', async (t) => {
  const f = await fixture(t);
  await fs.rename(f.cwd, f.cwd + '-moved');
  await fs.writeFile(f.cwd, 'fixture');
  assert.equal(
    (await f.bridge.create({ project: f.cwd, text: 'first' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal(
    (await f.bridge.send({ session_id: f.session.id, text: 'fixture' })).reason,
    'EXECUTION_CWD_UNAVAILABLE',
  );
  assert.equal(f.starts(), 0);
  assert.equal((await fs.readdir(f.config.sessionRoots[0])).length, 1);
  await fs.unlink(f.cwd);
  await fs.symlink(f.cwd + '-moved', f.cwd);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (await f.bridge.send({ session_id: f.session.id, text: 'fixture' })).status,
    ),
  );
  // Recorded project identity remains the original configured path, not the symlink target.
  f.config.grants = [{ folder: f.cwd + '-moved', list: true, read: true }];
  assert.deepEqual((await f.bridge.list()).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: f.session.id }), /NOT_FOUND_OR_DENIED/);
});

test('stream parser preserves LF framing and validates header independently', async (t) => {
  const f = await fixture(t);
  await fs.appendFile(
    f.session.file,
    JSON.stringify({
      type: 'message',
      id: 'u',
      parentId: null,
      message: { role: 'user', content: 'line\u2028paragraph\u2029ok' },
    }) + '\n',
  );
  const loaded = await loadSession(f.session.file);
  assert.equal(loaded.entries[0].message.content, 'line\u2028paragraph\u2029ok');
  await fs.writeFile(
    f.session.file,
    '{"type":"session","id":"oversized-header","cwd":"' + 'x'.repeat(65536),
  );
  await assert.rejects(readSessionIdentity(f.session.file), /INVALID_SESSION_HEADER/);
  assert.deepEqual(await discover(f.config), []);
  await fs.writeFile(
    f.session.file,
    JSON.stringify({ ...f.session.header, cwd: f.cwd + '\0suffix' }) + '\n',
  );
  await assert.rejects(readSessionIdentity(f.session.file), /INVALID_SESSION_HEADER/);
});
