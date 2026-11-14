import { denyAllPermissions } from './fixtures/permissions.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { permitted, resolvePermission } from '../src/permissions.mjs';
import { readOwnerConfig, editPermission, permissionDetails } from '../src/owner-config.mjs';
import ownerPermissions from '../src/owner-permissions-extension.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-perm-')),
    cwd = path.join(dir, 'project'),
    child = path.join(cwd, 'child');
  await fs.mkdir(child, { recursive: true });
  const file = path.join(dir, 'owner.json');
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }, { path: child }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
    piRuntime: { inheritEnv: ['PATH'], tools: ['read'] },
  };
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, cwd, child, file, config };
}

test('owner edits preserve unrelated config/rules and retain inheritance/null semantics', async (t) => {
  const f = await fixture(t);
  let snapshot = await readOwnerConfig(f.file);
  snapshot = await editPermission(f.file, snapshot.revision, { folder: f.child }, 'read', false);
  assert.equal(permitted(snapshot.config, 'read', { cwd: f.child }), false);
  assert.equal(permitted(snapshot.config, 'send', { cwd: f.child }), true);
  snapshot = await editPermission(
    f.file,
    snapshot.revision,
    { session_id: 'fixture-session' },
    'read',
    true,
  );
  const target = { session_id: 'fixture-session', cwd: f.child };
  assert.equal(permissionDetails(snapshot.config, 'read', target).source, 'this session');
  snapshot = await editPermission(f.file, snapshot.revision, target, 'read', null);
  assert.equal(permitted(snapshot.config, 'read', { id: 'fixture-session', cwd: f.child }), false);
  assert.equal(permissionDetails(snapshot.config, 'read', target).allowed, false);
  snapshot = await editPermission(f.file, snapshot.revision, { folder: f.child }, 'read', null);
  assert.equal(permitted(snapshot.config, 'read', { id: 'fixture-session', cwd: f.child }), true);
  assert.ok(permissionDetails(snapshot.config, 'read', target).source.includes(f.cwd));
  assert.deepEqual(snapshot.config.piRuntime, f.config.piRuntime);
  assert.deepEqual(snapshot.config.folders, f.config.folders);
  assert.deepEqual(snapshot.config.grants[0], f.config.grants[0]);
  await assert.rejects(
    editPermission(f.file, snapshot.revision, target, 'create', true),
    /INVALID_PERMISSION_EDIT/,
  );
});
test('owner edit refuses concurrent changes and writes only the selected permission', async (t) => {
  const f = await fixture(t);
  const before = await readOwnerConfig(f.file);
  await fs.writeFile(f.file, JSON.stringify({ ...f.config, piRuntime: { tools: [] } }));
  await assert.rejects(
    editPermission(f.file, before.revision, { folder: f.cwd }, 'send', false),
    /OWNER_CONFIG_CHANGED/,
  );
  assert.deepEqual((await readOwnerConfig(f.file)).config.piRuntime, { tools: [] });
});
test('permission menu registers only a human TUI shortcut and aborts on lifecycle change', async (t) => {
  const f = await fixture(t),
    prior = process.env.PI_MCP_OWNER_CONFIG;
  process.env.PI_MCP_OWNER_CONFIG = f.file;
  const handlers = {},
    shortcuts = [];
  const pi = {
    on: (name, handler) => {
      handlers[name] = handler;
    },
    registerShortcut: (key, options) => shortcuts.push({ key, ...options }),
    registerCommand: () => assert.fail('Permission command must not be remotely dispatchable'),
    registerTool: () => assert.fail('No permission tool'),
  };
  ownerPermissions(pi);
  assert.equal(shortcuts[0].key, 'ctrl+alt+p');
  const ui = {
    notify: () => {},
    setStatus: () => {},
    select: () => assert.fail('Non-TUI menu must not open'),
  };
  try {
    await shortcuts[0].handler({ mode: 'rpc', hasUI: true, ui });
    const choices = ['This project', 1, 'Block', 'Done'];
    const ctx = {
      mode: 'tui',
      hasUI: true,
      cwd: f.cwd,
      ui: {
        ...ui,
        select: async (_title, options) => {
          const value = choices.shift();
          return typeof value === 'number' ? options[value] : value;
        },
      },
    };
    handlers.session_start({}, ctx);
    await shortcuts[0].handler(ctx);
    assert.equal(permitted((await readOwnerConfig(f.file)).config, 'read', { cwd: f.cwd }), false);
    ctx.ui.select = async () => {
      handlers.session_shutdown();
      return 'This project';
    };
    const unchanged = await fs.readFile(f.file, 'utf8');
    await shortcuts[0].handler(ctx);
    assert.equal(await fs.readFile(f.file, 'utf8'), unchanged);
  } finally {
    if (prior === undefined) delete process.env.PI_MCP_OWNER_CONFIG;
    else process.env.PI_MCP_OWNER_CONFIG = prior;
  }
});

test('shared permission resolver preserves effective values, explicit inheritance and source scope', () => {
  const config = {
      grants: [
        { folder: '/project', list: true, read: true, send: true, create: false },
        { folder: '/project/child', read: false, send: false },
        { folder: '/project/child', read: null },
        { session_id: 's', read: false, create: true },
        { session_id: 's', read: null, send: true },
        { folder: '/project', delete: true },
        { folder: '/project', delete: false },
      ],
    },
    before = structuredClone(config);
  const child = { session_id: 's', cwd: '/project/child' };
  for (const [action, target, allowed, explicit, sourceScope, source] of [
    ['read', child, true, null, { folder: '/project' }, 'project /project'],
    ['send', child, true, true, { session_id: 's' }, 'this session'],
    [
      'send',
      { ...child, session_id: 'other' },
      false,
      undefined,
      { folder: '/project/child' },
      'project /project/child',
    ],
    ['create', child, false, true, { folder: '/project' }, 'project /project'],
    [
      'send',
      { folder: '/project/child' },
      false,
      false,
      { folder: '/project/child' },
      'this project',
    ],
    ['delete', { folder: '/project' }, false, false, { folder: '/project' }, 'this project'],
    ['read', { folder: '/project2' }, false, undefined, { default: true }, 'default'],
  ]) {
    assert.deepEqual(resolvePermission(config, action, target), { allowed, explicit, sourceScope });
    assert.deepEqual(permissionDetails(config, action, target), { allowed, explicit, source });
  }
  assert.deepEqual(config, before);
});
