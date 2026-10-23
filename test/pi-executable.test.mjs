import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolvePiInstallation, loadPiSdk, loadPiAi } from '../src/pi-installation.mjs';
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

test('PATH skips absent, directory and non-executable entries, not an unusable selected installation', async (t) => {
  const f = await fixture(t),
    a = await f.install('native'),
    bin = await f.link('bin', a.command);
  await fs.mkdir(path.join(f.dir, 'directory/pi'), { recursive: true });
  await fs.mkdir(path.join(f.dir, 'denied'));
  await fs.writeFile(path.join(f.dir, 'denied/pi'), 'not executable', { mode: 0o600 });
  assert.equal(
    (
      await resolvePiInstallation(
        {},
        {
          PATH: ['absent', 'directory', 'denied', 'bin']
            .map((p) => path.join(f.dir, p))
            .join(path.delimiter),
        },
      )
    ).command,
    path.join(bin, 'pi'),
  );
  await fs.unlink(path.join(a.root, 'dist/index.js'));
  await assert.rejects(resolvePiInstallation({}, { PATH: bin }), /PI_INSTALLATION_UNAVAILABLE/);
});

test('explicit selection fails accurately without using PATH or installing a fallback', async (t) => {
  const f = await fixture(t),
    native = await f.install('native'),
    bin = await f.link('bin', native.command);
  await assert.rejects(
    resolvePiInstallation({ piExecutable: path.join(f.dir, 'missing') }, { PATH: bin }),
    /PI_EXECUTABLE_NOT_FOUND/,
  );
  await fs.chmod(native.command, 0o600);
  await assert.rejects(
    resolvePiInstallation({ piExecutable: native.command }, { PATH: bin }),
    /PI_EXECUTABLE_NOT_EXECUTABLE/,
  );
  await assert.rejects(
    resolvePiInstallation({ piExecutable: f.dir }),
    /PI_EXECUTABLE_NOT_EXECUTABLE/,
  );
  for (const piExecutable of ['relative', null, '/bad/\0pi'])
    await assert.rejects(resolvePiInstallation({ piExecutable }), /INVALID_PI_EXECUTABLE/);
  await assert.rejects(resolvePiInstallation({}, { PATH: f.dir }), /PI_EXECUTABLE_NOT_FOUND/);
});

test('external CLI, SDK and thinking helpers use the selected installation', async () => {
  assert.equal(await loadPiSdk(installation), sdk);
  assert.equal(
    (await promisify(execFile)(installation.command, ['--version'])).stdout.trim(),
    installation.version,
  );
  const ai = await loadPiAi(installation);
  assert.ok(ai.getSupportedThinkingLevels({ reasoning: false }).includes('off'));
  assert.ok(!installation.packageRoot.startsWith(path.resolve('node_modules') + path.sep));
});
