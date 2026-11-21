import { shortTempDir } from './fixtures/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { once } from 'node:events';
import { kernelLock } from '../src/core/kernel-lock.mjs';
import { parseDarwinProcessIdentity } from '../src/core/process-identity.mjs';
import { opaqueId } from '../src/core/storage.mjs';
import { spawn } from 'node:child_process';

test('macOS locks exclude the previous socket implementation in both directions', async (t) => {
  const tmp = await shortTempDir('pi-lock-');
  // Exercise both the complete name and the name legacy Node truncated at 104
  // bytes. The explicit truncation also checks it on Linux and with newer Node.
  const dir = path.join(tmp, 'x'.repeat(76 - Buffer.byteLength(tmp) - 1));
  const ns = 'upgrade:' + tmp;
  const id = opaqueId(ns);
  await fs.mkdir(dir, { mode: 0o700 });
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  for (const base of [tmp, dir]) {
    const address = Buffer.from(path.join(base, `${id}.sock`))
      .subarray(0, 104)
      .toString();
    const options = { useFileLock: true, dir: base };
    const old = net.createServer((socket) => socket.destroy());
    await once(old.listen(address), 'listening');
    try {
      await assert.rejects(kernelLock(ns, options), /LOCK_BUSY/);
      assert.ok((await fs.lstat(address)).isSocket());
    } finally {
      await new Promise((resolve) => old.close(resolve));
    }

    const upgraded = await kernelLock(ns, options);
    try {
      await assert.rejects(once(net.createServer().listen(address), 'listening'), {
        code: 'EADDRINUSE',
      });
      // The old close and stale-socket code both unlink by name. Neither can
      // delete a successor while it is holding the lock.
      await assert.rejects(fs.unlink(address), (error) => ['EPERM', 'EISDIR'].includes(error.code));
      await assert.rejects(kernelLock(ns, options), /LOCK_BUSY/);
    } finally {
      await upgraded.close();
    }
    const restarted = net.createServer();
    await once(restarted.listen(address), 'listening');
    await new Promise((resolve) => restarted.close(resolve));
  }
});

test('macOS locks reclaim the exact process marker after a crash', async (t) => {
  const dir = await shortTempDir('pi-lock-crash-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const namespace = 'crash:' + dir;
  const child = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { kernelLock } from ${JSON.stringify(new URL('../src/core/kernel-lock.mjs', import.meta.url).href)};
      await kernelLock(process.argv[1], { useFileLock: true, dir: process.argv[2] });
      process.send('locked');
      setInterval(() => {}, 1000);`,
      namespace,
      dir,
    ],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
  );
  const exited = once(child, 'exit');
  try {
    const acquired = once(child, 'message', { signal: AbortSignal.timeout(5000) });
    assert.equal((await Promise.race([acquired, exited]))[0], 'locked');
    await assert.rejects(kernelLock(namespace, { useFileLock: true, dir }), /LOCK_BUSY/);
    child.kill('SIGKILL');
    await exited;

    const contenders = await Promise.allSettled(
      Array.from({ length: 4 }, () => kernelLock(namespace, { useFileLock: true, dir })),
    );
    const acquiredLocks = contenders.filter((result) => result.status === 'fulfilled');
    await Promise.all(acquiredLocks.map(({ value }) => value.close()));
    assert.equal(acquiredLocks.length, 1);
    for (const result of contenders)
      if (result.status === 'rejected') assert.match(result.reason.message, /LOCK_BUSY/);
    assert.deepEqual(await fs.readdir(dir), []);
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
});

test('macOS uses one short lock across temp environments and rejects an unusable legacy path', async (t) => {
  const dir = await shortTempDir('pi-lock-path-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ns = 'short-lock:' + dir;
  const originalTemp = process.env.TMPDIR;
  const [first, second] = ['first', 'second'].map((suffix) => path.join(dir, suffix));
  process.env.TMPDIR = first;
  let held;
  try {
    held = await kernelLock(ns, { useFileLock: true });
    process.env.TMPDIR = second;
    await assert.rejects(kernelLock(ns, { useFileLock: true }), /LOCK_BUSY/);
  } finally {
    if (originalTemp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = originalTemp;
    await held?.close();
  }
  await assert.rejects(
    kernelLock(ns, { useFileLock: true, dir: path.join(dir, 'a'.repeat(85)) }),
    /LOCK_PATH_TOO_LONG/,
  );
});

test('parseDarwinProcessIdentity parses macOS ps output and zombie states', () => {
  const alive = parseDarwinProcessIdentity(
    '  S+   Sat Nov 21 12:00:00 2026\n',
    'darwin-boot-1',
    42,
  );
  assert.deepEqual(alive, {
    pid: 42,
    start: 'Sat Nov 21 12:00:00 2026',
    boot: 'darwin-boot-1',
    state: 'S+',
  });
  assert.equal(parseDarwinProcessIdentity('   \n', 'darwin-boot-1', 42), null);
});
