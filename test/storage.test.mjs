import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { atomicJson } from '../src/storage.mjs';

test('atomic JSON failures preserve the published record and remove uncommitted temporary files', async (t) => {
  for (const stage of ['write', 'file sync', 'rename', 'directory sync'])
    await t.test(stage, async (t) => {
      const dir = await fs.mkdtemp('/tmp/bridge-atomic-storage-'),
        file = dir + '/record.json',
        previous = { generation: 'old' },
        next = { generation: 'new' };
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      await atomicJson(file, previous);
      const failure = Object.assign(new Error('fixture I/O failure'), { code: 'EIO' });
      if (stage === 'rename')
        t.mock.method(fs, 'rename', async () => {
          throw failure;
        });
      else {
        const open = fs.open;
        t.mock.method(fs, 'open', async (...args) => {
          const handle = await open(...args);
          if (String(args[0]).endsWith('.tmp') && stage === 'write') {
            const write = handle.writeFile.bind(handle);
            t.mock.method(handle, 'writeFile', async () => {
              await write('{');
              throw failure;
            });
          } else if (
            (String(args[0]).endsWith('.tmp') && stage === 'file sync') ||
            (args[0] === dir && stage === 'directory sync')
          )
            t.mock.method(handle, 'sync', async () => {
              throw failure;
            });
          return handle;
        });
      }
      await assert.rejects(atomicJson(file, next), (error) => error === failure);
      assert.deepEqual(
        JSON.parse(await fs.readFile(file, 'utf8')),
        stage === 'directory sync' ? next : previous,
      );
      assert.deepEqual(await fs.readdir(dir), ['record.json']);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    });
});
