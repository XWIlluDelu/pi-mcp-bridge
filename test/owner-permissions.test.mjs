import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { permitted, resolvePermission } from '../src/permissions.mjs';
import {
  readOwnerConfig,
  editPermission,
  permissionDetails,
  validateGrants,
} from '../src/owner-config.mjs';
import ownerPermissions from '../src/owner-permissions-extension.mjs';
import { SessionManager } from './fixtures/pi.mjs';
import { opaqueId } from '../src/storage.mjs';
import { Bridge } from '../src/bridge.mjs';
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
test('grant scopes require exactly one present and valid scope field', () => {
  for (const rule of [
    {},
    { session_id: 17 },
    { session_id: null },
    { session_id: '' },
    { session_id: 'x'.repeat(129) },
    { folder: 17 },
    { folder: null },
    { folder: '' },
    { folder: 'relative' },
    { session_id: 'valid', folder: '/project' },
    { session_id: 17, folder: '/project' },
    { session_id: null, folder: '/project' },
    { session_id: '', folder: '/project' },
    { session_id: 'valid', folder: null },
    { session_id: 'valid', folder: 17 },
    { session_id: 'valid', folder: '' },
  ]) {
    assert.throws(() => validateGrants([{ ...rule, read: false }]), /INVALID_OWNER_CONFIG/);
  }
  assert.doesNotThrow(() =>
    validateGrants([
      { session_id: 'valid', read: false },
      { folder: '/project', read: null },
    ]),
  );
});
test('live reload rejects malformed denial rather than silently retaining prior folder allowance', async (t) => {
  const f = await fixture(t),
    bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  try {
    const made = await savedSession(bridge);
    await bridge.read({ session_id: made.session_id });
    for (const session_id of [17, null, '']) {
      await fs.writeFile(
        f.file,
        JSON.stringify({
          ...f.config,
          grants: [...f.config.grants, { session_id, folder: f.cwd, read: false }],
        }),
      );
      await assert.rejects(bridge.read({ session_id: made.session_id }), /INVALID_OWNER_CONFIG/);
    }
  } finally {
    await bridge.close();
  }
});
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
function permissionMenu(t, file, context) {
  const prior = process.env.PI_MCP_OWNER_CONFIG;
  process.env.PI_MCP_OWNER_CONFIG = file;
  t.after(() => {
    if (prior === undefined) delete process.env.PI_MCP_OWNER_CONFIG;
    else process.env.PI_MCP_OWNER_CONFIG = prior;
  });
  let shortcut, choices;
  const selections = [],
    notices = [];
  ownerPermissions({
    on() {},
    registerShortcut: (_key, value) => {
      shortcut = value.handler;
    },
    registerCommand: () => assert.fail('Permission edits remain owner-local'),
    registerTool: () => assert.fail('Permission edits remain owner-local'),
  });
  const ctx = {
    mode: 'tui',
    hasUI: true,
    ...context,
    ui: {
      notify: (message, level) => notices.push({ message, level }),
      select: async (title, options) => {
        selections.push({ title, options });
        const value = choices.shift();
        const selected = typeof value === 'number' ? options[value] : value;
        assert.ok(options.includes(selected), `Unavailable menu choice: ${selected}`);
        return selected;
      },
    },
  };
  return {
    selections,
    notices,
    async run(...values) {
      choices = values;
      await shortcut(ctx);
      assert.deepEqual(choices, [], notices.map(({ message }) => message).join('\n'));
    },
  };
}

for (const replacement of ['missing', 'symlink'])
  test(`owner can revoke recorded project permissions after the workspace becomes ${replacement}`, async (t) => {
    const f = await fixture(t);
    await fs.rm(f.cwd, { recursive: true });
    const outside = path.join(f.dir, 'outside');
    if (replacement === 'symlink') {
      await fs.mkdir(outside);
      await fs.symlink(outside, f.cwd);
    }
    const before = await readOwnerConfig(f.file);
    const after = await editPermission(f.file, before.revision, { folder: f.cwd }, 'read', false);
    assert.equal(permitted(after.config, 'read', { projectCwd: f.cwd, cwd: null }), false);
    assert.equal(permitted(after.config, 'read', { cwd: outside }), false);
    assert.equal(after.config.grants[0].folder, f.cwd);
    assert.deepEqual(after.config.folders, before.config.folders);
  });

test('owner menu edits defaults and project rules without requiring a workspace or creation target', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ ...f.config, folders: [] }));
  await fs.rm(f.cwd, { recursive: true });
  const menu = permissionMenu(t, f.file, { cwd: f.cwd });
  await menu.run('Defaults', 1, 'Allow', 'Done');
  assert.equal((await readOwnerConfig(f.file)).config.defaults.read, true);
  await menu.run('This project', 2, 'Block', 'Done');
  assert.equal(permitted((await readOwnerConfig(f.file)).config, 'send', { cwd: f.cwd }), false);
  await menu.run('Another configured project', f.cwd, 2, 'Allow', 'Done');
  const after = await readOwnerConfig(f.file);
  assert.equal(permitted(after.config, 'send', { cwd: f.cwd }), true);
  assert.deepEqual(after.config.folders, []);
  assert.ok(menu.notices.every((notice) => notice.level === 'info'));
});

test('owner session menu uses the reserved native identity and recorded project before first persistence', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.config.sessionRoots[0]);
  const manager = SessionManager.create(f.cwd, f.config.sessionRoots[0]);
  const file = manager.getSessionFile();
  const id = opaqueId(`${file}\0${manager.getSessionId()}`);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await fs.rm(f.cwd, { recursive: true });
  const menu = permissionMenu(t, f.file, { cwd: f.dir, sessionManager: manager });
  await menu.run('This session', 1, 'Block', 'Done');
  const readRows = menu.selections.find(({ title }) => title === 'This session').options;
  assert.ok(readRows[1].startsWith('Read: Allowed'));
  assert.ok(readRows[1].includes(f.cwd));
  const after = await readOwnerConfig(f.file);
  assert.equal(permitted(after.config, 'read', { id, projectCwd: f.cwd }), false);
  assert.equal(permitted(after.config, 'read', { id: 'another', projectCwd: f.cwd }), true);
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  // Granting a reserved identity must not permit aliases to substitute another file.
  await fs.symlink(f.file, file);
  await menu.run('This session');
  assert.equal((await readOwnerConfig(f.file)).revision, after.revision);
  assert.equal(menu.notices.at(-1).level, 'error');
});

test('running bridge reloads valid permissions independently of pending fixed settings', async (t) => {
  const f = await fixture(t);
  const bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  try {
    const made = await savedSession(bridge);
    let snapshot = await readOwnerConfig(f.file);
    await editPermission(f.file, snapshot.revision, { session_id: made.session_id }, 'read', false);
    assert.deepEqual(
      (await bridge.list()).sessions.map((row) => row.session_id),
      [made.session_id],
    );
    await assert.rejects(bridge.read({ session_id: made.session_id }), /NOT_FOUND_OR_DENIED/);
    await fs.writeFile(f.file, JSON.stringify({ ...f.config, piArgs: ['--offline'] }));
    assert.deepEqual(
      (await bridge.list()).sessions.map((row) => row.session_id),
      [made.session_id],
    );
    assert.equal((await bridge.read({ session_id: made.session_id })).session_id, made.session_id);
    assert.deepEqual((await bridge.health()).restart_required, ['piArgs']);
    await fs.writeFile(f.file, 'broken');
    await assert.rejects(bridge.list(), /INVALID_OWNER_CONFIG/);
  } finally {
    await bridge.close();
  }
});

test('shutdown prevents dispatch after an asynchronous permission snapshot', async (t) => {
  const f = await fixture(t);
  const bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  const made = await savedSession(bridge);
  const send = bridge.send({
    session_id: made.session_id,

    text: 'must not dispatch',
  });
  const closed = bridge.close();
  await assert.rejects(send, /BRIDGE_CLOSING/);
  await closed;
  assert.equal(bridge.pool.instances.size, 0);
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
  const cases = [
    {
      action: 'read',
      target: { session_id: 's', cwd: '/project/child' },
      allowed: true,
      explicit: null,
      scope: { folder: '/project' },
      label: 'project /project',
    },
    {
      action: 'send',
      target: { session_id: 's', cwd: '/project/child' },
      allowed: true,
      explicit: true,
      scope: { session_id: 's' },
      label: 'this session',
    },
    {
      action: 'send',
      target: { session_id: 'other', cwd: '/project/child' },
      allowed: false,
      explicit: undefined,
      scope: { folder: '/project/child' },
      label: 'project /project/child',
    },
    {
      action: 'create',
      target: { session_id: 's', cwd: '/project/child' },
      allowed: false,
      explicit: true,
      scope: { folder: '/project' },
      label: 'project /project',
    },
    {
      action: 'read',
      target: { folder: '/project/child' },
      allowed: true,
      explicit: null,
      scope: { folder: '/project' },
      label: 'project /project',
    },
    {
      action: 'send',
      target: { folder: '/project/child' },
      allowed: false,
      explicit: false,
      scope: { folder: '/project/child' },
      label: 'this project',
    },
    {
      action: 'delete',
      target: { folder: '/project' },
      allowed: false,
      explicit: false,
      scope: { folder: '/project' },
      label: 'this project',
    },
    {
      action: 'read',
      target: { folder: '/project2' },
      allowed: false,
      explicit: undefined,
      scope: { default: true },
      label: 'default',
    },
  ];
  for (const c of cases) {
    assert.deepEqual(resolvePermission(config, c.action, c.target), {
      allowed: c.allowed,
      explicit: c.explicit,
      sourceScope: c.scope,
    });
    assert.equal(
      permitted(config, c.action, {
        id: c.target.session_id,
        cwd: c.target.cwd ?? c.target.folder,
      }),
      c.allowed,
    );
    assert.deepEqual(permissionDetails(config, c.action, c.target), {
      allowed: c.allowed,
      explicit: c.explicit,
      source: c.label,
    });
  }
  assert.deepEqual(config, before);
});
