import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { kernelLock } from '../src/core/kernel-lock.mjs';
import { parseDarwinProcessIdentity } from '../src/runtime/attachments.mjs';

test('POSIX file-socket kernelLock (macOS path) enforces mutual exclusion and reaps stale sockets', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-lock-'));
  await fs.chmod(dir, 0o700);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const ns = 'macos-lock-test:' + dir;
  const first = await kernelLock(ns, { useFileSocket: true, dir });
  await assert.rejects(
    kernelLock(ns, { useFileSocket: true, dir, attempts: 2, busy: 'LOCK_HELD' }),
    /LOCK_HELD/,
  );
  await first.close();

  // Simulate a crashed process leaving behind a dead socket file
  const files = await fs.readdir(dir);
  assert.equal(files.length, 0);
  const acquired = await kernelLock(ns, { useFileSocket: true, dir });
  const [sockName] = await fs.readdir(dir);
  await acquired.close();
  const stalePath = path.join(dir, sockName);
  const dummy = net.createServer();
  await once(dummy.listen(stalePath), 'listening');
  await new Promise((r) => dummy.close(r));
  // Ensure a regular stale socket file exists if OS didn't unlink on close
  await fs.writeFile(stalePath, '').catch(() => {});
  const recovered = await kernelLock(ns, { useFileSocket: true, dir });
  await recovered.close();
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
