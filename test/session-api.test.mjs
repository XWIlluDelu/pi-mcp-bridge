import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Bridge } from '../src/bridge.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { validateOwnerConfig } from '../src/owner-config.mjs';
import { permitted, permissionWarnings } from '../src/permissions.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
import { executeBatch } from '../src/batch.mjs';

async function fixture(t, defaults = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-session-api-'),
    project = path.join(dir, 'project');
  await fs.mkdir(project);
  const config = {
    principal: 'test',
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'p', path: project }],
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

test('seven permissions inherit independently; legacy configs and typo denials fail closed', () => {
  const config = {
    principal: 'p',
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
  for (const rule of [
    { session_id: 's', raed: false },
    { folder: '/project', new_session: true },
    { folder: '/project', bash: true },
  ])
    assert.throws(
      () => validateOwnerConfig({ ...config, grants: [rule] }),
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
  const seed = await savedSession(f.bridge),
    id = seed.session_id,
    session = await f.bridge.session(id);
  await fs.appendFile(
    session.file,
    JSON.stringify({ type: 'session_info', id: 'name', parentId: null, name: 'a"b' }) + '\n',
  );
  assert.deepEqual((await f.bridge.list()).sessions, []);
  assert.equal(
    (await f.bridge.send({ session_id: id, request_id: 'known', text: 'hello' })).status,
    'accepted',
  );
  assert.equal((await f.bridge.read({ session_id: id })).format, 'context_timeline');
  f.config.grants = [{ session_id: id, list: true, read: false }];
  const list = await f.bridge.list({ name: 'a"b' });
  assert.equal(list.sessions[0].name, 'a"b');
  assert.equal(list.sessions[0].project, f.project);
  assert.equal(list.sessions[0].status.state, 'idle');
  assert.deepEqual((await f.bridge.list({ name: 'null' })).sessions, []);
  assert.deepEqual((await f.bridge.list({ name: 'name' })).sessions, []);
  await assert.rejects(f.bridge.read({ session_id: id }), /NOT_FOUND_OR_DENIED/);
});

test('create-and-send uses only create permission and replays without a second child', async (t) => {
  const f = await fixture(t, { send: false, read: false, list: false });
  const args = { project: f.project, text: 'first prompt', name: 'child', request_id: 'new' };
  const result = await f.bridge.create(args);
  assert.equal(result.status, 'accepted');
  assert.equal(result.created, true);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command.streamingBehavior, 'steer');
  assert.deepEqual(await f.bridge.create(args), result);
  assert.deepEqual(await f.bridge.create({ project: f.project, request_id: 'new' }), result);
  assert.equal((await f.bridge.sessions()).length, 1);
  assert.equal(
    (await f.bridge.send({ session_id: result.session_id, request_id: 'later', text: 'no' }))
      .status,
    'rejected',
  );
  await assert.rejects(f.bridge.create({ ...args, text: 'changed' }), /REQUEST_ID_CONFLICT/);
});

test('fork copies committed native branch, keeps parent owner, and uses target permissions', async (t) => {
  const f = await fixture(t);
  const parent = await f.bridge.create({
    project: f.project,
    text: 'parent',
    request_id: 'parent',
  });
  const source = await f.bridge.session(parent.session_id);
  const before = await fs.readFile(source.file, 'utf8'),
    runtime = f.bridge.pool.get(source.id);
  f.config.defaults.send = false;
  const child = await f.bridge.create({
    project: f.project,
    text: 'child prompt',
    fork_from: source.id,
    request_id: 'child',
  });
  assert.equal(child.status, 'accepted');
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
        request_id: 'denied',
      })
    ).reason,
    'NOT_FOUND_OR_DENIED',
  );
});

test('health needs no redundant domain selector and retains explicit permissions compatibility', async (t) => {
  const { bridge } = await fixture(t);
  const explicit = await callBridgeTool(bridge, 'health', { domain: 'permissions' });
  assert.deepEqual(await callBridgeTool(bridge, 'health', {}), explicit);
  assert.equal(explicit.isError, undefined);
  assert.equal((await callBridgeTool(bridge, 'health', { domain: 'unsupported' })).isError, true);
});
test('retired status/wait parameters are not an alternate public or internal read API', () => {
  for (const schema of [publicSchemas.read]) {
    for (const args of [
      { view: 'status' },
      { wait_ms: 0 },
      { after_settlement: { generation: 'g', sequence: 0 } },
    ])
      assert.equal(schema.safeParse({ session_id: 'known', ...args }).success, false);
  }
});
test('failed first send preserves created identity; retry never starts another writer', async (t) => {
  const f = await fixture(t);
  f.bridge.pool.factory = async () => {
    throw new Error('RUNTIME_START_FAILED');
  };
  const args = { project: f.project, text: 'will fail', request_id: 'failure' };
  const result = await f.bridge.create(args);
  assert.equal(result.created, true);
  assert.equal(result.status, 'rejected');
  assert.ok(result.session_id);
  assert.deepEqual(await f.bridge.create(args), result);
  assert.equal((await f.bridge.sessions()).length, 1);
});

test('default send queues with native steer and receipt replay rechecks permission', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge);
  const args = { session_id: seed.session_id, text: 'work', request_id: 'send' };
  await f.bridge.send(args);
  assert.equal(f.calls[0].command.streamingBehavior, 'steer');
  f.config.defaults.send = false;
  assert.equal((await f.bridge.send(args)).reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(f.calls.length, 1);
});

test('batch runs independent sessions concurrently, serializes ACKs in one lane and isolates malformed items', async () => {
  const starts = [],
    gate = Promise.withResolvers();
  const bridge = {
    send: async (args) => {
      starts.push('send:' + args.session_id);
      if (args.session_id === 'a') await gate.promise;
      return { status: 'accepted' };
    },
    stop: async () => {
      starts.push('stop:a');
      return { status: 'accepted' };
    },
    list: async () => ({ sessions: [] }),
    health: async () => ({ status: 'ok' }),
  };
  const batch = executeBatch(bridge, {
    operations: [
      { op: 'send', args: { session_id: 'a', request_id: 'a', text: 'a' } },
      { op: 'stop', args: { session_id: 'a', request_id: 'stop' } },
      { op: 'send', args: { session_id: 'b', request_id: 'b', text: 'b' } },
      { op: 'send', args: { session_id: 'c', request_id: 'bad id' } },
      { op: 'list', args: {} },
      { op: 'health', args: { domain: 'permissions' } },
    ],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, ['send:a', 'send:b']);
  gate.resolve();
  const result = await batch;
  assert.deepEqual(starts, ['send:a', 'send:b', 'stop:a']);
  assert.deepEqual(
    result.results.map((item) => item.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(result.results[3].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[4].result.sessions.length, 0);
});
