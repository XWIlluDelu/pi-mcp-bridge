import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { openProfile, openSession } from '../src/open.mjs';
import { opaqueId } from '../src/storage.mjs';
test('open starts a fresh native TUI with normal configuration and automatic safe join, never the target file', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-open-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const cwd = path.join(dir, 'project'),
    root = path.join(dir, 'sessions');
  await fs.mkdir(cwd);
  await fs.mkdir(root);
  const target = path.join(root, 'target.jsonl');
  await fs.writeFile(
    target,
    JSON.stringify({ type: 'session', id: 'native', version: 3, cwd }) + '\n',
  );
  const id = opaqueId(target + '\0native'),
    file = path.join(dir, 'owner.json'),
    config = {
      principal: 'open-fixture',
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [root],
      folders: [{ id: 'p', path: cwd }],
      grants: [],
    };
  await fs.writeFile(file, JSON.stringify(config));
  const host = { HOME: dir, PATH: '/bin', SYNTHETIC_NATIVE_VALUE: 'retained' };
  const profile = await openProfile(file, id, host);
  assert.equal(profile.cwd, cwd);
  assert.equal(profile.env.HOME, dir);
  assert.equal(profile.env.SYNTHETIC_NATIVE_VALUE, 'retained');
  assert.equal(profile.env.PI_MCP_OWNER_CONFIG, file);
  assert.equal(profile.env.PI_MCP_ATTACH_DIR, path.join(dir, 'state', 'ipc'));
  assert.equal(profile.args.at(-1), '/bridge-join ' + id);
  for (const forbidden of [
    '--session',
    '--resume',
    '--continue',
    '--no-extensions',
    '--no-tools',
    target,
  ])
    assert.equal(profile.args.includes(forbidden), false);
  await fs.writeFile(file, JSON.stringify({ ...config, piExecutable: '/synthetic/bin/pi' }));
  const selected = await openProfile(file, id, host);
  assert.equal(selected.command, '/synthetic/bin/pi');
  assert.equal(selected.args[0], '-e');
  await fs.writeFile(file, JSON.stringify(config));
  let observed;
  await openSession(file, id, {
    hostEnv: host,
    spawnProcess: (...args) => {
      observed = args;
      return { synthetic: true };
    },
  });
  assert.equal(observed[2].stdio, 'inherit');
  assert.equal(observed[2].cwd, cwd);
  for (const flag of [
    '--session',
    '--session=unsafe',
    '--continue',
    '--fork',
    '--mode',
    '--print',
    '-r',
    '@unsafe',
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...config, piArgs: [flag] }));
    await assert.rejects(openProfile(file, id, host), /UNSAFE_OPEN_PI_ARGS/);
  }
});
