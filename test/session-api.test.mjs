import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { prepareContextRead } from './fixtures/read-pages.mjs';
import { validateOwnerConfig } from '../src/owner-config.mjs';
import { permitted, permissionWarnings } from '../src/permissions.mjs';

async function fixture(t, defaults = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-session-api-'),
    project = path.join(dir, 'project');
  await fs.mkdir(project);
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    piRuntime: { agentDir: path.join(dir, 'agent'), inheritEnv: [] },
    piArgs: ['--session-dir', path.join(dir, 'sessions')],
    folders: [{ path: project }],
    defaults: {
      ...denyAllPermissions(),
      list: true,
      read: true,
      send: true,
      create: true,
      delete: true,
      ...defaults,
    },
  };
  const calls = [];
  const bridge = await new Bridge(config, async (session) => ({
    alive: true,
    entries: () => loadSavedSession(session),
    read: async (args) => prepareContextRead(await loadSavedSession(session), args),
    state: async () => ({ isIdle: true, isStreaming: false, pendingMessageCount: 0 }),
    command: async (command) => {
      calls.push({ session: session.id, command });
      const saved = await loadSavedSession(session);
      await fs.appendFile(
        session.file,
        JSON.stringify({
          type: 'message',
          id: randomUUID(),
          parentId: saved.leafId,
          timestamp: new Date().toISOString(),
          message: { role: 'user', content: command.message },
        }) + '\n',
      );
      return { disposition: 'started' };
    },
    stop: async () => {},
  })).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, config, project, calls };
}

test('seven permissions inherit independently and typo denials fail closed', () => {
  const config = {
    stateDir: '/state',
    sessionRoots: ['/sessions'],
    folders: [],
    defaults: { ...denyAllPermissions(), read: true, send: true },
    grants: [
      { folder: '/project', read: false },
      { session_id: 's', read: true, stop: true },
    ],
  };
  validateOwnerConfig(config);
  assert.equal(permitted(config, 'list', { id: 's', cwd: '/project' }), false);
  assert.equal(permitted(config, 'read', { id: 's', cwd: '/project' }), true);
  assert.equal(permitted(config, 'send', { id: 's', cwd: '/project' }), true);
  assert.equal(permitted(config, 'command', { id: 's', cwd: '/project' }), false);
  assert.equal(permitted(config, 'stop', { id: 's', cwd: '/project' }), true);
  assert.throws(
    () => validateOwnerConfig({ ...config, defaults: { read: true, send: true } }),
    /INVALID_OWNER_CONFIG/,
  );
  assert.throws(
    () => validateOwnerConfig({ ...config, grants: [{ session_id: 's', raed: false }] }),
    /INVALID_PERMISSION_FIELD/,
  );
  assert.throws(
    () => validateOwnerConfig({ ...config, grants: [{ session_id: 's', create: true }] }),
    /CREATE_REQUIRES_PROJECT_SCOPE/,
  );
  assert.ok(
    permissionWarnings(config, { session_id: 's', cwd: '/project' }).warnings.some(
      (w) => w.code === 'KNOWN_ID_ONLY',
    ),
  );
});

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
  assert.deepEqual((await f.bridge.list({ name: 'null' })).sessions, []);
  assert.deepEqual((await f.bridge.list({ name: 'name' })).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: id }), /NOT_FOUND_OR_DENIED/);
});

test('creation targets use project list/create rights independently of session pages', async (t) => {
  const f = await fixture(t, { create: true, read: false, send: false }),
    other = path.join(path.dirname(f.project), 'other'),
    unused = path.join(path.dirname(f.project), 'unused'),
    legacy = path.join(f.project, 'not-configured');
  assert.deepEqual(
    (await f.bridge.list()).creatable_projects,
    [f.project],
    'An authorized empty project must be discoverable before its first session',
  );
  for (const directory of [other, unused, legacy]) await fs.mkdir(directory);
  f.config.folders.push({ path: other }, { path: unused }, { path: legacy });
  const rows = [];
  for (const [project, name] of [
    [f.project, 'Alpha one'],
    [f.project, 'Alpha two'],
    [other, 'Beta'],
    [legacy, 'Legacy'],
    [unused, 'Hidden'],
  ]) {
    const seed = await savedSession(f.bridge, { project }),
      session = await f.bridge.session(seed.session_id);
    await fs.appendFile(session.file, JSON.stringify({ type: 'session_info', name }) + '\n');
    const time = new Date(1700000000000 - rows.length * 1000);
    await fs.utimes(session.file, time, time);
    rows.push(seed.session_id);
  }
  f.config.folders = f.config.folders.filter((folder) => folder.path !== legacy);
  f.config.grants = [
    { folder: other, create: false },
    { session_id: rows[4], list: false },
  ];
  const all = await f.bridge.list();
  assert.equal(Object.hasOwn(all, 'projects'), false);
  assert.deepEqual(
    all.sessions.map((row) => row.session_id),
    rows.slice(0, 4),
  );
  assert.deepEqual(
    all.creatable_projects,
    [f.project, unused],
    'Session-specific denial does not hide the configured project; denied and unconfigured targets stay absent',
  );
  for (const args of [
    { limit: 1 },
    { offset: 3, limit: 1 },
    { offset: 100 },
    { project: other },
    { name: 'missing' },
    { session_id: rows[4] },
  ])
    assert.deepEqual((await f.bridge.list(args)).creatable_projects, [f.project, unused]);
  f.config.grants.push({ folder: other, create: true }, { folder: unused, list: false });
  assert.deepEqual((await f.bridge.list({ name: 'Beta' })).creatable_projects, [f.project, other]);
  await assert.rejects(f.bridge.read({ session_id: rows[0] }), /NOT_FOUND_OR_DENIED/);
  // A directory absent from this page can still be a valid configured create target.
  const created = await f.bridge.create({
    project: unused,

    text: 'FIRST',
  });
  assert.ok(['started', 'queued', 'handled'].includes(created.status), JSON.stringify(created));
  const denied = await f.bridge.create({
    project: legacy,

    text: 'NEVER',
  });
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.reason, 'NOT_FOUND_OR_DENIED');
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
  const child = await f.bridge.create({
    project: f.project,
    text: 'child prompt',
    fork_from: source.id,
  });
  assert.ok(['started', 'queued', 'handled'].includes(child.status), JSON.stringify(child));
  assert.strictEqual(f.bridge.pool.get(source.id), runtime);
  assert.equal(await fs.readFile(source.file, 'utf8'), before);
  const saved = await loadSavedSession(await f.bridge.session(child.session_id));
  assert.equal(saved.header.parentSession, source.file);
  assert.deepEqual(
    saved.entries.filter((e) => e.type === 'message').map((e) => e.message.content),
    ['parent', 'child prompt'],
  );
  assert.equal(
    (await f.bridge.list({ session_id: child.session_id })).sessions[0].parent_session_id,
    source.id,
  );
  f.config.grants = [{ session_id: source.id, read: false }];
  assert.equal(
    (
      await f.bridge.create({
        project: f.project,
        text: 'denied',
        fork_from: source.id,
      })
    ).reason,
    'NOT_FOUND_OR_DENIED',
  );
});

test('failed first send preserves its created identity', async (t) => {
  const f = await fixture(t);
  f.bridge.pool.factory = async () => {
    throw new Error('RUNTIME_START_FAILED');
  };
  const args = { project: f.project, text: 'will fail' };
  const result = await f.bridge.create(args);
  assert.equal(result.created, true);
  assert.equal(result.status, 'rejected');
  assert.ok(result.session_id);

  assert.equal((await f.bridge.sessions()).length, 1);
});

test('default send uses native steer and new calls recheck permission', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge);
  const args = { session_id: seed.session_id, text: 'work' };
  await f.bridge.send(args);
  assert.equal(f.calls[0].command.streamingBehavior, 'steer');
  f.config.defaults.send = false;
  assert.equal((await f.bridge.send(args)).reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(f.calls.length, 1);
});
