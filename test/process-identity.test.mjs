import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { processIdentity, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';

test('real proc stat open/read exit race returns ESRCH and is conclusively absent', async (t) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    env: { PATH: process.env.PATH },
    stdio: 'ignore',
  });
  await once(child, 'spawn');
  const owner = await processIdentity(child.pid),
    file = `/proc/${child.pid}/stat`,
    read = fs.readFile;
  let code;
  t.mock.method(fs, 'readFile', async function (target, ...args) {
    if (target !== file) return read.call(fs, target, ...args);
    const fd = await fs.open(target, 'r');
    const exit = once(child, 'exit');
    child.kill('SIGTERM');
    await exit;
    try {
      return await fd.readFile(...args);
    } catch (error) {
      code = error.code;
      throw error;
    } finally {
      await fd.close();
    }
  });
  try {
    assert.equal(await processIdentity(child.pid), null);
    assert.equal(code, 'ESRCH');
    t.mock.restoreAll();
    assert.equal(await processIdentity(child.pid), null);
    assert.equal(await ownerAlive(owner), false);
    await waitOwnerExit(owner, 100);
  } finally {
    t.mock.restoreAll();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
    }
  }
});
test('boot identity failures and other proc errors remain fail-closed with original cause', async (t) => {
  const read = fs.readFile,
    statPath = `/proc/${process.pid}/stat`,
    bootPath = '/proc/sys/kernel/random/boot_id';
  const owner = await processIdentity();
  for (const [target, code] of [
    [bootPath, 'ENOENT'],
    [bootPath, 'ESRCH'],
    [statPath, 'EACCES'],
    [statPath, 'EIO'],
  ]) {
    const cause = Object.assign(new Error('controlled identity read failure'), {
      code,
      syscall: 'read',
      path: target,
    });
    t.mock.method(fs, 'readFile', async function (file, ...args) {
      if (file === target) throw cause;
      return read.call(fs, file, ...args);
    });
    try {
      await assert.rejects(
        processIdentity(),
        (error) => error.code === 'PROCESS_IDENTITY_UNAVAILABLE' && error.cause === cause,
      );
      await assert.rejects(
        ownerAlive(owner),
        (error) => error.code === 'PROCESS_IDENTITY_UNAVAILABLE' && error.cause === cause,
      );
    } finally {
      t.mock.restoreAll();
    }
  }
  t.mock.method(fs, 'readFile', async function (file, ...args) {
    if (file === statPath) return 'malformed stat';
    return read.call(fs, file, ...args);
  });
  await assert.rejects(ownerAlive(owner), { code: 'PROCESS_IDENTITY_UNAVAILABLE' });
});
