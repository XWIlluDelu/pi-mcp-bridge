import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateOwnerConfig, readOwnerConfig } from '../src/core/owner-config.mjs';
import { loadHttpConfig } from '../src/mcp/http-config.mjs';
import { Bridge } from '../src/core/bridge.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-config-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'),
    file = path.join(dir, 'owner.json');
  await fs.writeFile(tokenFile, 'T'.repeat(48), { mode: 0o600 });
  const config = {
    defaults: {},
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    http: { port: 43125, tokenFile },
  };
  const save = (value = config) => fs.writeFile(file, JSON.stringify(value), { mode: 0o600 });
  await save();
  const start = async () => {
    const bridge = await new Bridge(config, undefined, { configFile: file }).init();
    t.after(() => bridge.close());
    return bridge;
  };
  return { dir, file, config, save, start };
}

test('current policy validates without mutation and snapshot rejects invalid changes', async (t) => {
  const f = await fixture(t),
    snapshot = structuredClone(f.config);
  assert.strictEqual(validateOwnerConfig(f.config), f.config);
  assert.deepEqual(f.config, snapshot);
  const [root] = f.config.sessionRoots;
  assert.doesNotThrow(() =>
    validateOwnerConfig({ ...f.config, sessionRoots: [root, root + '-2'] }),
  );
  assert.throws(
    () => validateOwnerConfig({ ...f.config, sessionRoots: [root, root + '-2', root + '/child'] }),
    /OVERLAPPING_STORAGE/,
  );
  const bridge = await f.start();
  const first = await bridge.captureRequestContext();
  assert.strictEqual(await bridge.captureRequestContext(), first);
  const { permissions } = first;
  assert.ok(Object.isFrozen(permissions.defaults) && Object.isFrozen(permissions.grants));
  await f.save({ ...f.config, defaults: { ...f.config.defaults, send: 'invalid' } });
  await assert.rejects(bridge.captureRequestContext(), /INVALID_OWNER_CONFIG/);
  assert.deepEqual(bridge.config, snapshot);
});

test('scope reload stays read-only; fixed settings await restart without blocking requests', async (t) => {
  const f = await fixture(t),
    bridge = await f.start(),
    root = path.join(f.dir, 'new-root'),
    alias = path.join(f.dir, 'root-alias');
  const { save } = f;
  await save({ ...f.config, sessionRoots: [root], folders: [] });
  const context = await bridge.captureRequestContext();
  assert.deepEqual(context.scope, { sessionRoots: [root], folders: [] });
  assert.deepEqual((await bridge.list()).sessions, []);
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  await fs.mkdir(root, { mode: 0o700 });
  await fs.symlink(root, alias);
  await save({ ...f.config, sessionRoots: [alias] });
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

test('private owner file checks agree across snapshot, readers and direct stdio startup', async (t) => {
  const f = await fixture(t);
  const bridge = await f.start();
  await fs.chmod(f.file, 0o666);
  for (const op of [readOwnerConfig, loadHttpConfig, () => bridge.captureRequestContext()])
    await assert.rejects(op(f.file), /OWNER_CONFIG_NOT_PRIVATE/);
  await assert.rejects(
    promisify(execFile)(process.execPath, ['src/server.mjs', f.file], { timeout: 5000 }),
    (error) => /OWNER_CONFIG_NOT_PRIVATE/.test(error.stderr),
  );
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o666);
});

test('storage and config readers reject another uid even with private modes', async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.config.stateDir, { mode: 0o700 });
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
