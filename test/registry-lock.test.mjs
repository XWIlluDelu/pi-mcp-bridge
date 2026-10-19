import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { registryTransaction, processIdentity } from '../src/attachments.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-registry-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function writer(dir) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/registry-worker.mjs', import.meta.url)), dir],
    { env: { PATH: process.env.PATH, HOME: dir }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const messages = on(child, 'message', { close: ['exit'] }),
    exited = once(child, 'exit');
  async function next() {
    const event = await messages.next();
    assert.ok(!event.done, 'Worker exited: ' + stderr);
    return event.value[0];
  }
  const worker = {
    child,
    exited,
    next,
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await messages.return();
    },
  };
  assert.deepEqual(await next(), { type: 'ready' });
  return worker;
}
test(
  'registry excludes a live writer and serializes recovery after its death',
  { timeout: 15000 },
  async (t) => {
    const dir = await fixture(t),
      workers = [];
    try {
      const holder = await writer(dir);
      workers.push(holder);
      holder.child.send({ acquire: true });
      assert.equal((await holder.next()).type, 'entered');
      // A live owner is never evicted to meet a wait timeout.
      await assert.rejects(
        registryTransaction(dir, () => assert.fail('stole live lock')),
        /ATTACHMENT_REGISTRY_BUSY/,
      );
      await holder.close();
      // Only the synthetic assertion marker needs cleanup after killing its writer.
      await fs.unlink(path.join(dir, 'critical'));
      const contenders = await Promise.all(Array.from({ length: 4 }, () => writer(dir)));
      workers.push(...contenders);
      const pending = new Map(
        contenders.map((worker) => {
          worker.child.send({ acquire: true });
          return [worker, worker.next().then((message) => ({ worker, message }))];
        }),
      );
      while (pending.size) {
        const { worker, message } = await Promise.race(pending.values());
        assert.equal(message.type, 'entered', JSON.stringify(message));
        assert.equal(
          await fs.readFile(path.join(dir, 'critical'), 'utf8'),
          String(worker.child.pid),
        );
        worker.child.send({ release: true });
        assert.deepEqual(await worker.next(), { type: 'done' });
        pending.delete(worker);
      }
      assert.deepEqual(await fs.readdir(dir), []);
    } finally {
      await Promise.all(workers.map((worker) => worker.close()));
    }
  },
);

test(
  'recovery does not unlink a live replacement of the observed dead inode',
  { timeout: 5000 },
  async (t) => {
    const dir = await fixture(t),
      lock = path.join(dir, 'registry.lock'),
      owner = await processIdentity();
    await fs.writeFile(lock, JSON.stringify({ ...owner, start: '0' }), { mode: 0o600 });
    const lstat = fs.lstat;
    let replaced = false;
    t.mock.method(fs, 'lstat', async (file, ...args) => {
      if (file === lock && !replaced) {
        replaced = true;
        // The writer may release and another writer acquire while a
        // reaper is checking the first identity. Its open fd pins the old inode.
        await fs.unlink(lock);
        await fs.writeFile(lock, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
      }
      return lstat(file, ...args);
    });
    await assert.rejects(
      registryTransaction(dir, () => assert.fail('stole replacement')),
      /ATTACHMENT_REGISTRY_BUSY/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(JSON.parse(await fs.readFile(lock, 'utf8')), owner);
  },
);

test('directory spelling aliases share the same recovery gate', { timeout: 5000 }, async (t) => {
  const dir = await fixture(t),
    lock = path.join(dir, 'registry.lock'),
    owner = await processIdentity();
  await fs.writeFile(lock, JSON.stringify({ ...owner, start: '0' }), { mode: 0o600 });
  let reached,
    release,
    observed,
    checking = false,
    binds = 0;
  const atCheck = new Promise((resolve) => {
      reached = resolve;
    }),
    continueCheck = new Promise((resolve) => {
      release = resolve;
    });
  const secondBind = new Promise((resolve) => {
    observed = resolve;
  });
  const lstat = fs.lstat,
    listen = net.Server.prototype.listen;
  t.mock.method(fs, 'lstat', async (file, ...args) => {
    if (file === lock && !checking) {
      checking = true;
      reached();
      await continueCheck;
    }
    return lstat(file, ...args);
  });
  t.mock.method(net.Server.prototype, 'listen', function (...args) {
    if (++binds === 2) {
      this.once('listening', () => observed('listening'));
      this.once('error', (error) => observed(error.code));
    }
    return listen.apply(this, args);
  });
  const first = registryTransaction(dir, () => 1);
  let second;
  try {
    await atCheck;
    second = registryTransaction(dir + '/.', () => 2);
    assert.equal(await secondBind, 'EADDRINUSE');
  } finally {
    release();
    await Promise.allSettled([first, second]);
  }
  assert.equal(await first, 1);
  assert.equal(await second, 2);
});

test('publication exposes a complete identity and an action failure releases the registry', async (t) => {
  const dir = await fixture(t),
    lock = path.join(dir, 'registry.lock'),
    link = fs.link;
  const { state, ...owner } = await processIdentity();
  let published = false;
  t.mock.method(fs, 'link', async (from, to) => {
    if (to === lock) {
      const { state, ...staged } = JSON.parse(await fs.readFile(from, 'utf8'));
      assert.deepEqual(staged, owner);
      await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
      published = true;
    }
    return link(from, to);
  });
  const failure = new Error('action failed');
  await assert.rejects(
    registryTransaction(dir, async () => {
      const { state, ...stored } = JSON.parse(await fs.readFile(lock, 'utf8'));
      assert.deepEqual(stored, owner);
      assert.deepEqual(await fs.readdir(dir), ['registry.lock']);
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(published, true);
  assert.deepEqual(await fs.readdir(dir), []);
  assert.equal(await registryTransaction(dir, () => 42), 42);
});
