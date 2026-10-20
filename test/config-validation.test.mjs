import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateOwnerConfig, readOwnerConfig } from '../src/owner-config.mjs';
import { loadHttpConfig } from '../src/http-server.mjs';
import { checkOwner } from '../deploy/check-owner.mjs';
import { Bridge } from '../src/bridge.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-config-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const tokenFile = path.join(dir, 'token'),
    file = path.join(dir, 'owner.json');
  await fs.writeFile(tokenFile, 'T'.repeat(48), { mode: 0o600 });
  const config = {
    principal: 'fixture',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: dir }],
    http: { port: 43125, tokenFile },
  };
  return { dir, file, config };
}
test('configuration shape errors agree across init, reload reader, preflight and HTTP', async (t) => {
  const f = await fixture(t);
  const invalid = [
    { principal: 42 },
    { principal: ' ' },
    { version: 2 },
    { arbitrary: 'unknown' },
    { defaults: undefined, grants: [{ folder: f.dir, command: true }] },
    { defaults: { command: true }, grants: [{ folder: f.dir, command: true }] },
    { defaults: { read: true, send: true } },
    { defaults: { ...denyAllPermissions(), stop: undefined } },
    { piRuntime: { unsafeEnv: true } },
    { sessionRoots: ['relative'] },
    { grants: [{ folder: `${f.dir}\0`, command: false }] },
    { folders: {} },
    { folders: [{ id: 'folder', path: f.dir, command: true }] },
    {
      folders: [
        { id: 'duplicate', path: f.dir },
        { id: 'duplicate', path: f.dir },
      ],
    },
    { attachmentDir: '' },
    { attachmentExitTimeoutMs: 49 },
    { piArgs: '--offline' },
    { piRuntime: { tools: ['unknown'] } },
    { http: { port: 0, tokenFile: f.config.http.tokenFile } },
  ];
  for (const patch of invalid) {
    const config = { ...f.config, ...patch };
    let code;
    try {
      validateOwnerConfig(config);
      assert.fail('Expected invalid config');
    } catch (error) {
      code = error.message;
    }
    await fs.writeFile(f.file, JSON.stringify(config), { mode: 0o600 });
    for (const operation of [
      () => readOwnerConfig(f.file),
      () => checkOwner(f.file),
      () => loadHttpConfig(f.file),
    ])
      await assert.rejects(operation, { message: code });
    const bridge = new Bridge(config);
    try {
      await assert.rejects(bridge.init(), { message: code });
    } finally {
      await bridge.close();
    }
    await assert.rejects(fs.stat(f.config.stateDir), { code: 'ENOENT' });
  }
});
test('current policy validates without mutation and refresh rejects invalid changes', async (t) => {
  const f = await fixture(t),
    snapshot = structuredClone(f.config);
  assert.strictEqual(validateOwnerConfig(f.config), f.config);
  assert.deepEqual(f.config, snapshot);
  const bridge = await new Bridge(f.config, undefined, { configFile: f.file }).init();
  try {
    await fs.writeFile(f.file, JSON.stringify({ ...f.config, grants: [] }));
    await bridge.refreshPermissions();
    assert.deepEqual(bridge.config.grants, []);
    await fs.writeFile(f.file, JSON.stringify({ ...f.config, principal: 42 }));
    await assert.rejects(bridge.refreshPermissions(), /INVALID_OWNER_CONFIG/);
  } finally {
    await bridge.close();
  }
  const withMetadata = { ...snapshot, notes: { futureOwnerField: true } };
  assert.throws(() => validateOwnerConfig(withMetadata), /INVALID_OWNER_CONFIG/);
});
