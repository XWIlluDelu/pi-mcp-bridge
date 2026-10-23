import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOwnerConfig, readOwnerConfig } from '../src/owner-config.mjs';
import { loadHttpConfig } from '../src/http-server.mjs';
import { Bridge } from '../src/bridge.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'),
    file = path.join(dir, 'owner.json');
  await fs.writeFile(tokenFile, 'T'.repeat(48), { mode: 0o600 });
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    http: { port: 43125, tokenFile },
  };
  return { dir, file, config };
}
test('configuration shape errors agree across init, reload reader and HTTP', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { arbitrary: 'unknown' },
    { herdr: 'true' },
    { herdr: null },
    { defaults: undefined, grants: [{ folder: f.dir, command: true }] },
    { defaults: { command: true }, grants: [{ folder: f.dir, command: true }] },
    { defaults: { read: true, send: true } },
    { defaults: { ...denyAllPermissions(), stop: undefined } },
    { piRuntime: { unsafeEnv: true } },
    { sessionRoots: ['relative'] },
    { grants: [{ folder: `${f.dir}\0`, command: false }] },
    { folders: {} },
    { folders: [{ path: f.dir, command: true }] },
    {
      folders: [{ path: f.dir }, { path: f.dir }],
    },
    { attachmentDir: '' },
    { attachmentExitTimeoutMs: 49 },
    { piArgs: '--offline' },
    { compatibilityModules: 'module.mjs' },
    { compatibilityModules: ['relative.mjs'] },
    { compatibilityModules: [{ module: 'relative.mjs' }] },
    { compatibilityModules: [{ module: '/absolute\0module.mjs' }] },
    { compatibilityModules: [{ module: '/absolute.mjs', enabled: 'yes' }] },
    { compatibilityModules: [{ module: '/absolute.mjs', options: [] }] },
    { compatibilityModules: [{ module: '/absolute.mjs', unknown: true }] },
    { compatibilityModules: [{ module: '/absolute.mjs' }, { module: '/absolute.mjs' }] },
    { piRuntime: { tools: ['unknown'] } },
    { http: { port: 0, tokenFile: f.config.http.tokenFile } },
  ];
  for (const patch of invalid) {
    const config = { ...f.config, ...patch };
    let code;
    try {
      validateOwnerConfig(config);
      assert.fail('Expected invalid config');
    } catch (error) {
      code = error.message;
    }
    await fs.writeFile(f.file, JSON.stringify(config), { mode: 0o600 });
    for (const operation of [() => readOwnerConfig(f.file), () => loadHttpConfig(f.file)])
      await assert.rejects(operation, { message: code });
    const bridge = new Bridge(config);
    try {
      await assert.rejects(bridge.init(), { message: code });
    } finally {
      await bridge.close();
    }
    await assert.rejects(fs.stat(f.config.stateDir), { code: 'ENOENT' });
  }
});
test('current policy validates without mutation and snapshot rejects invalid changes', async (t) => {
  const f = await fixture(t),
    snapshot = structuredClone(f.config);
  assert.strictEqual(validateOwnerConfig(f.config), f.config);
  assert.deepEqual(f.config, snapshot);
  const bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  try {
    await fs.writeFile(f.file, JSON.stringify({ ...f.config, grants: [] }), { mode: 0o600 });
    const context = await bridge.captureRequestContext();
    assert.deepEqual(context.permissions.grants, []);
    assert.deepEqual(bridge.config, snapshot);
    assert.ok(Object.isFrozen(context.permissions.defaults));
    assert.ok(Object.isFrozen(context.permissions.grants));
    await fs.writeFile(
      f.file,
      JSON.stringify({ ...f.config, defaults: { ...f.config.defaults, send: 'invalid' } }),
    );
    await assert.rejects(bridge.captureRequestContext(), /INVALID_OWNER_CONFIG/);
  } finally {
    await bridge.close();
  }
});

test('scope reload stays read-only; fixed settings await restart without blocking requests', async (t) => {
  const f = await fixture(t),
    bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init(),
    root = path.join(f.dir, 'new-root'),
    alias = path.join(f.dir, 'root-alias');
  t.after(() => bridge.close());
  const save = (config) => fs.writeFile(f.file, JSON.stringify(config), { mode: 0o600 });
  await save({ ...f.config, sessionRoots: [root], folders: [] });
  const context = await bridge.captureRequestContext();
  assert.deepEqual(context.scope, { sessionRoots: [root], folders: [] });
  await bridge.health();
  assert.deepEqual((await bridge.list()).sessions, []);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.symlink(root, alias);
  await save({ ...f.config, sessionRoots: [alias] });
  await bridge.health();
  await assert.rejects(bridge.list(), /UNSAFE_NATIVE_SESSION_STORAGE/);
  await save({ ...f.config, sessionRoots: [f.config.stateDir] });
  await assert.rejects(bridge.captureRequestContext(), /OVERLAPPING_STORAGE/);
  for (const patch of [
    { piArgs: ['--offline'] },
    { stateDir: path.join(f.dir, 'different-state') },
    { attachmentExitTimeoutMs: 6000 },
    { compatibilityModules: [{ module: '/not-loaded-until-restart.mjs', enabled: false }] },
  ]) {
    await save({ ...f.config, ...patch });
    const context = await bridge.captureRequestContext();
    assert.deepEqual(context.restartRequired, Object.keys(patch));
    assert.ok(Object.isFrozen(context.restartRequired));
    assert.deepEqual((await bridge.list()).sessions, []);
    assert.deepEqual((await bridge.health()).restart_required, Object.keys(patch));
  }
  assert.equal(bridge.config.attachmentExitTimeoutMs, undefined);
  await save({
    ...f.config,
    stateDir: path.join(f.dir, 'different-state'),
    sessionRoots: [f.config.stateDir],
  });
  await assert.rejects(bridge.captureRequestContext(), /OVERLAPPING_STORAGE/);
  await save(f.config);
  assert.deepEqual(await bridge.health(), { domain: 'permissions', status: 'ok' });
});

for (const which of ['stateDir'])
  test(`private storage checks agree for ${which}`, async (t) => {
    const f = await fixture(t),
      dir = which === 'stateDir' ? f.config.stateDir : f.config.sessionRoots[0];
    await fs.writeFile(f.file, JSON.stringify(f.config), { mode: 0o600 });
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.chmod(dir, 0o777);
    const bridge = new Bridge(f.config);
    try {
      await assert.rejects(bridge.init(), /STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY/);
    } finally {
      await bridge.close();
    }
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o777);
  });

test('private owner file checks agree across snapshot, readers and direct stdio startup', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify(f.config), { mode: 0o600 });
  const bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  try {
    await bridge.captureRequestContext();
    await fs.chmod(f.file, 0o666);
    for (const op of [
      () => readOwnerConfig(f.file),
      () => loadHttpConfig(f.file),
      () => bridge.captureRequestContext(),
    ])
      await assert.rejects(op, /OWNER_CONFIG_NOT_PRIVATE/);
    await assert.rejects(
      promisify(execFile)(process.execPath, ['src/server.mjs', f.file], { timeout: 5000 }),
      (error) => {
        assert.match(error.stderr, /OWNER_CONFIG_NOT_PRIVATE/);
        return true;
      },
    );
    assert.equal((await fs.stat(f.file)).mode & 0o777, 0o666);
  } finally {
    await bridge.close();
  }
});

test('storage and config readers reject another uid even with private modes', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.config.stateDir, { mode: 0o700 });
  await fs.writeFile(f.file, JSON.stringify(f.config), { mode: 0o600 });
  const lstat = fs.lstat;
  t.mock.method(fs, 'lstat', async function (file, ...args) {
    const stat = await lstat(file, ...args);
    if (file === f.config.stateDir) stat.uid = process.getuid() + 1;
    return stat;
  });
  await assert.rejects(new Bridge(f.config).init(), /STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY/);
  t.mock.restoreAll();
  const open = fs.open;
  t.mock.method(fs, 'open', async function (file, ...args) {
    const fd = await open(file, ...args);
    if (file === f.file) {
      const stat = fd.stat.bind(fd);
      fd.stat = async () => {
        const result = await stat();
        result.uid = process.getuid() + 1;
        return result;
      };
    }
    return fd;
  });
  for (const read of [() => readOwnerConfig(f.file), () => loadHttpConfig(f.file)])
    await assert.rejects(read, /OWNER_CONFIG_NOT_PRIVATE/);
});
