import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  resolvePiInstallation,
  piLaunchEnvironment,
  loadPiSdk,
  loadPiAi,
} from '../src/runtime/pi-installation.mjs';
import { installation, sdk } from './fixtures/pi.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-installation-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  async function install(relative, version = 'fixture') {
    const root = path.join(dir, relative);
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version,
        type: 'module',
        bin: { pi: './dist/cli.js' },
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    const command = path.join(root, 'dist/cli.js');
    await fs.writeFile(command, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await fs.writeFile(
      path.join(root, 'dist/index.js'),
      'export const version = ' + JSON.stringify(version) + ';',
    );
    return { root, command };
  }
  async function link(relative, command) {
    const bin = path.join(dir, relative);
    await fs.mkdir(bin, { recursive: true });
    await fs.symlink(command, path.join(bin, 'pi'));
    return bin;
  }
  return { dir, install, link };
}

test('PATH and explicit selection resolve CLI and SDK from the same installation', async (t) => {
  const f = await fixture(t),
    a = await f.install('bridge/native install', 'a'),
    b = await f.install('other', 'b'),
    first = await f.link('first', a.command),
    second = await f.link('second', b.command);
  await fs.writeFile(
    path.join(f.dir, 'bridge/package.json'),
    JSON.stringify({ name: 'pi-mcp-bridge' }),
  );
  const env = { PATH: first + path.delimiter + second };
  const selected = await resolvePiInstallation({}, env);
  assert.equal(selected.command, path.join(first, 'pi'));
  assert.equal(selected.packageRoot, a.root);
  assert.equal((await resolvePiInstallation({ piExecutable: a.command }, env)).packageRoot, a.root);
  assert.equal((await loadPiSdk(selected)).version, 'a');
  const explicit = await resolvePiInstallation({ piExecutable: b.command }, env);
  assert.equal((await loadPiSdk(explicit)).version, 'b');
  assert.equal(
    (await resolvePiInstallation({}, { PATH: 'first' }, f.dir)).command,
    path.join(first, 'pi'),
  );
});

async function managedFixture(t) {
  const f = await fixture(t),
    agent = path.join(f.dir, 'managed agent'),
    managedRoot = path.join(agent, 'install'),
    launcher = path.join(agent, 'bin/pi');
  await fs.mkdir(path.dirname(launcher), { recursive: true });
  // Resolution must select the release, never execute this switching launcher.
  await fs.writeFile(launcher, '#!/bin/sh\nexit 91\n', { mode: 0o700 });
  const bin = await f.link('public-bin', launcher),
    releases = new Map();
  for (const version of ['1.5.0', '1.6.0']) {
    const relative = `managed agent/install/releases/${version}/node_modules`,
      installed = await f.install(`${relative}/@earendil-works/pi-coding-agent`, version);
    await f.link(`${relative}/.bin`, installed.command);
    await fs.writeFile(
      installed.command,
      `#!/usr/bin/env node\nconsole.log(JSON.stringify({version:${JSON.stringify(version)},root:process.env.PI_MANAGED_INSTALL_ROOT,path:process.env.PATH}));\n`,
    );
    releases.set(version, installed);
  }
  const marker = {
    kind: 'pi-managed-install',
    schemaVersion: 1,
    layout: 'releases-v1',
    entrypoint: { type: 'symlink', path: path.join(bin, 'pi') },
  };
  await fs.writeFile(path.join(managedRoot, 'managed-install.json'), JSON.stringify(marker));
  const select = (version) =>
    fs.writeFile(path.join(managedRoot, 'current-version'), version + '\n');
  await select('1.5.0');
  return { ...f, managedRoot, launcher, bin, marker, releases, select };
}

test('managed PATH and explicit launchers pin one release and preserve native launch environment', async (t) => {
  const f = await managedFixture(t),
    env = {
      PATH: f.bin + path.delimiter + '/usr/bin:/bin',
      HOME: path.join(f.dir, 'home'),
      XDG_DATA_HOME: path.join(f.dir, 'data'),
      PI_MANAGED_INSTALL_ROOT: '/another-installation',
    },
    selected = await resolvePiInstallation({}, env);
  assert.equal(selected.packageRoot, f.releases.get('1.5.0').root);
  assert.equal((await loadPiSdk(selected)).version, '1.5.0');
  assert.deepEqual(await resolvePiInstallation({ piExecutable: f.launcher }, env), selected);
  const withoutManagedNode = await piLaunchEnvironment(selected, env);
  assert.equal(withoutManagedNode.PATH, env.PATH);
  assert.equal(withoutManagedNode.PI_MANAGED_INSTALL_ROOT, f.managedRoot);

  const nodeBin = path.join(env.XDG_DATA_HOME, 'pi-node/current/bin');
  await fs.mkdir(nodeBin, { recursive: true });
  await fs.symlink(process.execPath, path.join(nodeBin, 'node'));
  const launchEnv = await piLaunchEnvironment(selected, env);
  assert.equal(env.PI_MANAGED_INSTALL_ROOT, '/another-installation');
  assert.equal(launchEnv.PATH, nodeBin + path.delimiter + env.PATH);
  await f.select('1.6.0');
  const { stdout } = await promisify(execFile)(selected.command, [], { env: launchEnv });
  assert.deepEqual(JSON.parse(stdout), {
    version: '1.5.0',
    root: f.managedRoot,
    path: launchEnv.PATH,
  });
  assert.equal((await loadPiSdk(selected)).version, '1.5.0');
  assert.equal((await resolvePiInstallation({}, env)).version, '1.6.0');
});

test('invalid managed releases and arbitrary wrappers fail without selecting another installation', async (t) => {
  const f = await managedFixture(t),
    fallback = await f.link('fallback', f.releases.get('1.6.0').command),
    env = { PATH: f.bin + path.delimiter + fallback },
    markerFile = path.join(f.managedRoot, 'managed-install.json');
  for (const version of ['../1.6.0', '9.9.9']) {
    await f.select(version);
    await assert.rejects(resolvePiInstallation({}, env), /PI_INSTALLATION_UNAVAILABLE/);
  }
  await f.select('1.5.0');
  const manifest = path.join(f.releases.get('1.5.0').root, 'package.json'),
    value = JSON.parse(await fs.readFile(manifest, 'utf8'));
  await fs.writeFile(manifest, JSON.stringify({ ...value, version: '1.6.0' }));
  await assert.rejects(resolvePiInstallation({}, env), /PI_INSTALLATION_UNAVAILABLE/);
  await fs.writeFile(manifest, JSON.stringify(value));
  await fs.writeFile(markerFile, JSON.stringify({ ...f.marker, layout: 'unknown' }));
  await assert.rejects(resolvePiInstallation({}, env), /PI_INSTALLATION_UNAVAILABLE/);
  await fs.unlink(markerFile);
  await assert.rejects(resolvePiInstallation({}, env), /PI_INSTALLATION_UNAVAILABLE/);
});

test('external CLI, SDK and thinking helpers use the selected installation', async () => {
  assert.equal(await loadPiSdk(installation), sdk);
  assert.equal(
    (
      await promisify(execFile)(installation.command, ['--version'], {
        env: await piLaunchEnvironment(installation, process.env),
      })
    ).stdout.trim(),
    installation.version,
  );
  const ai = await loadPiAi(installation);
  assert.ok(ai.getSupportedThinkingLevels({ reasoning: false }).includes('off'));
  assert.ok(!installation.packageRoot.startsWith(path.resolve('node_modules') + path.sep));
});
