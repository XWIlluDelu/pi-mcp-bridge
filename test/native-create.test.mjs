import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

for (const persistent of [false, true])
  test(`create retains published identity after ${persistent ? 'persistent' : 'one-time'} temporary-link cleanup failure`, async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-create-publication-'),
      root = path.join(dir, 'sessions'),
      config = {
        ...isolatedRuntime(dir),
        stateDir: path.join(dir, 'state'),
        sessionRoots: [root],
        folders: [{ path: dir }],
        defaults: { ...denyAllPermissions(), create: true },
      };
    const bridge = await new Bridge(config, () =>
      assert.fail('No writer after publication failure'),
    ).init();
    t.after(async () => {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const unlink = fs.unlink;
    let attempts = 0;
    const failure = t.mock.method(fs, 'unlink', async (file) => {
      if (
        file.startsWith(root + path.sep) &&
        file.endsWith('.pending') &&
        (++attempts === 1 || persistent)
      )
        throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
      return unlink(file);
    });
    const result = await bridge.create({ project: dir, text: 'NEVER_DISPATCH' });
    assert.equal(result.created, true, JSON.stringify(result));
    assert.equal(result.status, 'unknown');
    assert.equal(result.send.status, 'unknown');
    assert.match(result.session_id, /^ps_/);
    const files = await fs.readdir(root),
      published = files.find((file) => file.endsWith('.jsonl')),
      pending = files.find((file) => file.endsWith('.pending'));
    assert.ok(published);
    assert.equal(Boolean(pending), persistent);
    assert.equal((await fs.stat(path.join(root, published))).nlink, persistent ? 2 : 1);
    failure.mock.restore();
    if (pending) await fs.unlink(path.join(root, pending));
    assert.equal((await bridge.session(result.session_id)).file, path.join(root, published));
  });
