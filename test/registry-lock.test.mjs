import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { on, once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { registryTransaction } from '../src/attachments.mjs';

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
  'registry mutex excludes live contenders and is released by the kernel after process death',
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

test('canonical directory spellings use one mutex; action failures release it without lockfiles', async (t) => {
  const dir = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let secondEntered = false;
  const first = registryTransaction(dir, async () => {
    entered.resolve();
    await release.promise;
    return 1;
  });
  await entered.promise;
  const second = registryTransaction(dir + '/.', () => {
    secondEntered = true;
    return 2;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(secondEntered, false);
  assert.deepEqual(await fs.readdir(dir), [], 'A short transaction creates no lock/recovery files');
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);

  const failure = new Error('action failed');
  await assert.rejects(
    registryTransaction(dir, () => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(await registryTransaction(dir, () => 42), 42);
  assert.deepEqual(await fs.readdir(dir), []);
});
