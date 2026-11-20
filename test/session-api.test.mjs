import { append, message } from './fixtures/native-history.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { loadSavedSession } from '../src/core/data.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { prepareContextRead } from './fixtures/read-pages.mjs';

import { ownedRuntime } from './fixtures/owned-runtime.mjs';

async function fixture(t, defaults = {}) {
  const calls = [];
  const factory = async (session) =>
    ownedRuntime({
      alive: true,
      entries: () => loadSavedSession(session),
      read: async (args) => prepareContextRead(await loadSavedSession(session), args),
      state: async () => ({ isIdle: true, isStreaming: false, pendingMessageCount: 0 }),
      command: async (command) => {
        calls.push({ session: session.id, command });
        const saved = await loadSavedSession(session);
        await append(session, [message(randomUUID(), saved.leafId, 'user', command.message)]);
        return { disposition: 'started' };
      },
      stop: async () => {},
    });
  const f = await nativeOwner(t, {
    prefix: 'session-api',
    seed: false,
    factory,
    configure({ config }) {
      config.defaults = {
        ...config.defaults,
        list: true,
        read: true,
        send: true,
        create: true,
        delete: true,
        ...defaults,
      };
      config.grants = [];
    },
  });
  return { ...f, project: f.cwd, calls };
}

test('list permission owns metadata; hidden known IDs can still be read and sent', async (t) => {
  const f = await fixture(t, { list: false });
  assert.deepEqual((await f.bridge.list()).creatable_projects, []);
  const seed = await savedSession(f.bridge),
    id = seed.session_id,
    session = await f.bridge.session(id);
  await fs.appendFile(
    session.file,
    JSON.stringify({ type: 'session_info', id: 'name', parentId: null, name: 'a"b' }) + '\n',
  );
  assert.deepEqual((await f.bridge.list()).sessions, []);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (await f.bridge.send({ session_id: id, text: 'hello' })).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal((await f.bridge.read({ session_id: id })).session_id, id);
  f.config.grants = [{ session_id: id, list: true, read: false }];
  const list = await f.bridge.list({ name: 'a"b' });
  assert.equal(list.sessions[0].name, 'a"b');
  assert.equal(list.sessions[0].project, f.project);
  assert.equal(list.sessions[0].status.state, 'idle');
  await assert.rejects(f.bridge.read({ session_id: id }), /NOT_FOUND_OR_DENIED/);
});

test('creation targets use project list/create rights independently of session pages', async (t) => {
  const f = await fixture(t, { read: false, send: false });
  const other = path.join(f.dir, 'other'),
    unused = path.join(f.dir, 'unused');
  assert.deepEqual((await f.bridge.list()).creatable_projects, [f.project]);
  for (const project of [other, unused]) {
    await fs.mkdir(project);
    f.config.folders.push({ path: project });
  }
  const { session_id } = await savedSession(f.bridge, { project: unused });
  f.config.grants = [
    { folder: other, create: false },
    { session_id, list: false },
  ];
  for (const query of [{}, { offset: 100 }, { project: other, name: 'missing' }, { session_id }]) {
    const result = await f.bridge.list(query);
    assert.deepEqual(result.creatable_projects, [f.project, unused]);
    assert.deepEqual(result.sessions, []);
  }
  f.config.grants.push({ folder: other, create: true }, { folder: unused, list: false });
  assert.deepEqual((await f.bridge.list()).creatable_projects, [f.project, other]);
  assert.equal((await f.bridge.create({ project: unused, text: 'FIRST' })).status, 'started');
  const unconfigured = path.join(f.project, 'unconfigured');
  await fs.mkdir(unconfigured);
  assert.equal((await f.bridge.create({ project: unconfigured })).reason, 'NOT_FOUND_OR_DENIED');
});

test('create-and-send uses only create permission and returns its child identity', async (t) => {
  const f = await fixture(t, { send: false, read: false, list: false });
  const args = { project: f.project, text: 'first prompt', name: 'child' };
  const result = await f.bridge.create(args);
  assert.ok(['started', 'queued', 'handled'].includes(result.status), JSON.stringify(result));
  assert.equal(result.created, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command.streamingBehavior, 'steer');

  assert.equal((await f.bridge.sessions()).length, 1);
  assert.equal(
    (await f.bridge.send({ session_id: result.session_id, text: 'no' })).status,
    'rejected',
  );
});

test('fork copies committed native branch, keeps parent owner, and uses target permissions', async (t) => {
  const f = await fixture(t);
  const parent = await f.bridge.create({
    project: f.project,
    text: 'parent',
  });
  const source = await f.bridge.session(parent.session_id);
  const before = await fs.readFile(source.file, 'utf8'),
    runtime = f.bridge.pool.get(source.id);
  f.config.defaults.send = false;
  const prepared = await f.bridge.create({ project: f.project, fork_from: source.id });
  assert.equal(prepared.status, 'created');
  assert.equal(prepared.submission_id, undefined);
  assert.equal(f.bridge.pool.get(prepared.session_id), null);
  const history = (id) => f.bridge.session(id).then(loadSavedSession);
  const prompts = (saved) =>
    saved.entries.filter((e) => e.type === 'message').map((e) => e.message.content);
  assert.deepEqual(prompts(await history(prepared.session_id)), ['parent']);
  assert.equal(f.calls.length, 1, 'Preparing a fork must not send another prompt');
  const child = await f.bridge.create({
    project: f.project,
    text: 'child prompt',
    fork_from: source.id,
  });
  assert.ok(['started', 'queued', 'handled'].includes(child.status), JSON.stringify(child));
  assert.strictEqual(f.bridge.pool.get(source.id), runtime);
  assert.equal(await fs.readFile(source.file, 'utf8'), before);
  const saved = await history(child.session_id);
  assert.equal(saved.header.parentSession, source.file);
  assert.deepEqual(prompts(saved), ['parent', 'child prompt']);
  assert.equal(
    (await f.bridge.list({ session_id: child.session_id })).sessions[0].parent_session_id,
    source.id,
  );
  f.config.grants = [{ session_id: source.id, read: false }];
  for (const prompt of [{}, { text: 'denied' }])
    assert.equal(
      (await f.bridge.create({ project: f.project, fork_from: source.id, ...prompt })).reason,
      'NOT_FOUND_OR_DENIED',
    );
});
