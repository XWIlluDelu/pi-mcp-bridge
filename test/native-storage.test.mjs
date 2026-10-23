import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { loadSession } from '../src/data.mjs';
import { assertNativeDirectory, assertPrivateDirectory } from '../src/storage.mjs';
import { privateDirectory } from '../src/attachments.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

test('native umask directories work below private ancestors without chmod; mutable ancestors and files are checked', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-native-storage-'),
    root = dir + '/sessions',
    nested = root + '/native';
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(nested, { recursive: true, mode: 0o755 });
  await fs.chmod(root, 0o755);
  await fs.chmod(nested, 0o755);
  const file = nested + '/session.jsonl';
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'session', version: 3, id: 'native', cwd: dir }) + '\n',
    { mode: 0o644 },
  );
  const config = {
      stateDir: dir + '/state',
      sessionRoots: [root],
      folders: [],
      defaults: { ...denyAllPermissions(), list: true, read: true },
    },
    bridge = await new Bridge(config).init();
  try {
    assert.equal((await bridge.list()).sessions.length, 1);
    assert.equal((await fs.stat(nested)).mode & 0o777, 0o755);
    await fs.chmod(nested, 0o777);
    assert.equal((await loadSession(file)).header.id, 'native'); // Private ancestor protects access.
    await fs.chmod(dir, 0o755);
    await assert.rejects(loadSession(file), /UNSAFE_NATIVE_SESSION_STORAGE/);
    await fs.chmod(nested, 0o755);
    await assertNativeDirectory(nested);
    await fs.chmod(file, 0o666);
    await assert.rejects(loadSession(file), /UNSAFE_NATIVE_SESSION_STORAGE/);
    await fs.chmod(file, 0o644);
    await fs.chmod(root, 0o777); // Checking only native/ would miss this replaceable ancestor.
    await assert.rejects(loadSession(file), /UNSAFE_NATIVE_SESSION_STORAGE/);
  } finally {
    await bridge.close();
  }
});

test('control and native paths reject replaceable ancestors, while sticky and private ancestors protect owner entries', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-control-storage-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.chmod(dir, 0o755);
  const parent = path.join(dir, 'mutable'),
    child = path.join(parent, 'control');
  await fs.mkdir(parent);
  await fs.chmod(parent, 0o777);
  await fs.mkdir(child, { mode: 0o700 });
  for (const check of [assertNativeDirectory, assertPrivateDirectory, privateDirectory])
    await assert.rejects(check(child));
  const missing = path.join(parent, 'not-created');
  await assert.rejects(privateDirectory(missing));
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
  await fs.chmod(parent, 0o1777);
  for (const check of [assertNativeDirectory, assertPrivateDirectory, privateDirectory])
    await check(child);
  await fs.chmod(parent, 0o777);
  await fs.chmod(dir, 0o700);
  for (const check of [assertNativeDirectory, assertPrivateDirectory, privateDirectory])
    await check(child);
  assert.equal((await fs.stat(parent)).mode & 0o777, 0o777);
});
