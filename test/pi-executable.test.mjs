import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piCommand } from '../src/rpc.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-executable-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const binary = async (relative, mode = 0o700) => {
    const file = path.join(dir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode });
    return file;
  };
  return { dir, binary };
}

test('default launch selects the user executable from PATH, including spaces and symlinks', async (t) => {
  const f = await fixture(t),
    target = await f.binary('native install/pi'),
    link = path.join(f.dir, 'pi');
  await fs.symlink(target, link);
  assert.deepEqual(await piCommand({}, { PATH: f.dir }), { command: link, args: [] });
  assert.deepEqual(await piCommand({}, { PATH: path.dirname(target) }), {
    command: target,
    args: [],
  });
});

test('PATH search respects order and skips missing, directory and non-executable entries', async (t) => {
  const f = await fixture(t),
    denied = await f.binary('denied/pi', 0o600),
    first = await f.binary('first/pi'),
    second = await f.binary('second/pi');
  await fs.mkdir(path.join(f.dir, 'directory/pi'), { recursive: true });
  const env = {
    PATH: [
      path.join(f.dir, 'absent'),
      path.join(f.dir, 'directory'),
      path.dirname(denied),
      path.dirname(first),
      path.dirname(second),
    ].join(path.delimiter),
  };
  assert.equal((await piCommand({}, env)).command, first);
  assert.equal((await piCommand({}, { PATH: 'first' }, f.dir)).command, first);
});

test('npm-injected Bridge binaries and symlinks to its SDK never substitute for the user installation', async (t) => {
  const f = await fixture(t),
    native = await f.binary('user/pi');
  const bundled = fileURLToPath(
    new URL('../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', import.meta.url),
  );
  await fs.symlink(bundled, path.join(f.dir, 'pi'));
  assert.equal(
    (await piCommand({}, { PATH: f.dir + path.delimiter + path.dirname(native) })).command,
    native,
  );
  await assert.rejects(piCommand({}, { PATH: f.dir }), /PI_EXECUTABLE_NOT_FOUND/);
  const nested = await f.binary(
    'another-bridge/node_modules/@earendil-works/pi-coding-agent/cli.js',
  );
  await fs.mkdir(path.join(f.dir, 'another-bin'));
  await fs.symlink(nested, path.join(f.dir, 'another-bin/pi'));
  const manifest = path.join(f.dir, 'another-bridge/package.json');
  await fs.writeFile(manifest, JSON.stringify({ name: 'pi-mcp-bridge' }));
  const search = path.join(f.dir, 'another-bin') + path.delimiter + path.dirname(native);
  assert.equal((await piCommand({}, { PATH: search })).command, native);
  // A Pi installed by a different user project is not a Bridge dependency.
  await fs.writeFile(manifest, JSON.stringify({ name: 'user-project' }));
  assert.equal((await piCommand({}, { PATH: search })).command, path.join(f.dir, 'another-bin/pi'));
  // An explicit owner selection remains authoritative, including this test SDK.
  assert.deepEqual(await piCommand({ piExecutable: bundled }, { PATH: f.dir }), {
    command: bundled,
    args: [],
  });
});

test('explicit executable is authoritative and never falls back to another Pi', async (t) => {
  const f = await fixture(t),
    native = await f.binary('native/pi'),
    chosen = await f.binary('selected/pi');
  assert.deepEqual(await piCommand({ piExecutable: chosen }, { PATH: path.dirname(native) }), {
    command: chosen,
    args: [],
  });
  await assert.rejects(
    piCommand({ piExecutable: path.join(f.dir, 'absent') }, { PATH: path.dirname(native) }),
    /PI_EXECUTABLE_NOT_FOUND/,
  );
  await fs.chmod(chosen, 0o600);
  await assert.rejects(
    piCommand({ piExecutable: chosen }, { PATH: path.dirname(native) }),
    /PI_EXECUTABLE_NOT_EXECUTABLE/,
  );
  await assert.rejects(piCommand({ piExecutable: f.dir }, {}), /PI_EXECUTABLE_NOT_EXECUTABLE/);
  for (const piExecutable of ['relative', null, '/synthetic/\0pi'])
    await assert.rejects(piCommand({ piExecutable }), /INVALID_PI_EXECUTABLE/);
});

test('missing native Pi fails rather than using the development dependency', async (t) => {
  const f = await fixture(t);
  await assert.rejects(piCommand({}, { PATH: f.dir }), /PI_EXECUTABLE_NOT_FOUND/);
});
