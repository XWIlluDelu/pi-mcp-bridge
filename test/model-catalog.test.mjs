import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Bridge } from '../src/bridge.mjs';

import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

async function fixture(t, overrides = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-catalog-'),
    project = path.join(dir, 'project'),
    marker = path.join(dir, 'catalog-calls'),
    configFile = path.join(dir, 'owner.json'),
    config = {
      ...isolatedRuntime(dir),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: project }, { path: path.join(dir, 'unopened-project') }],
      defaults: denyAllPermissions(),
      grants: [{ folder: project, send: true }],
      ...overrides,
    };
  await fs.mkdir(project);
  await fs.mkdir(config.piRuntime.agentDir);
  const names = ['NODE_OPTIONS', 'BRIDGE_CATALOG_MARKER', 'BRIDGE_CATALOG_KEY'],
    previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  config.piRuntime.inheritEnv = names;
  process.env.NODE_OPTIONS =
    '--import=' + pathToFileURL(path.resolve('test/fixtures/catalog-guard.mjs'));
  process.env.BRIDGE_CATALOG_MARKER = marker;
  process.env.BRIDGE_CATALOG_KEY = 'SYNTHETIC_CATALOG_SECRET';
  await fs.writeFile(
    path.join(config.piRuntime.agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'catalog-fixture': {
          api: 'openai-completions',
          baseUrl: 'http://127.0.0.1:1/PRIVATE_ENDPOINT',
          apiKey: 'BRIDGE_CATALOG_KEY',
          headers: { 'X-Private': 'SYNTHETIC_HEADER_SECRET' },
          models: Array.from({ length: 33 }, (_, i) => ({
            id: String(i).padStart(2, '0'),
            name: 'Offline catalog model',
            input: ['text', 'image'],
            reasoning: true,
            contextWindow: 16000,
            maxTokens: 2048,
          })),
        },
      },
    }),
  );
  // These factories must never be loaded by directory discovery.
  const extensions = path.join(config.piRuntime.agentDir, 'extensions');
  await fs.mkdir(extensions);
  await fs.writeFile(
    path.join(extensions, 'poison.mjs'),
    "throw new Error('Catalog must not execute extension factories');",
  );
  await fs.writeFile(
    path.join(config.piRuntime.agentDir, 'settings.json'),
    JSON.stringify({ extensions: [path.join(extensions, 'poison.mjs')] }),
  );
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const bridge = await new Bridge(
    config,
    () => {
      throw new Error('UNEXPECTED_WRITER');
    },
    { configFile },
  ).init();
  t.after(async () => {
    try {
      await bridge.close();
    } finally {
      for (const name of names) {
        if (previous[name] === undefined) delete process.env[name];
        else process.env[name] = previous[name];
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  const policy = (grants, defaults = config.defaults) =>
    fs.writeFile(configFile, JSON.stringify({ ...config, grants, defaults }));
  const calls = () =>
    fs.readFile(marker, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    });
  return { dir, project, marker, config, configFile, bridge, policy, calls };
}

test('native catalog is offline, session-free, paged and sanitized in the owner launch environment', async (t) => {
  const f = await fixture(t),
    { bridge } = f;
  const env = { ...process.env };
  const first = await bridge.models({});
  assert.equal(first.models.length, 30);
  assert.equal(first.next_offset, 30);
  assert.deepEqual(Object.keys(first).sort(), ['models', 'next_offset']);
  assert.equal(first.models[0].id, '00');
  assert.deepEqual(first.models[0].input, ['text', 'image']);
  assert.deepEqual(
    Object.keys(first.models[0]).sort(),
    ['provider', 'id', 'name', 'input', 'context_window', 'thinking_levels'].sort(),
  );
  assert.ok(first.models[0].thinking_levels.includes('high'));
  assert.ok(!/SECRET|PRIVATE_ENDPOINT|apiKey|headers|baseUrl/.test(JSON.stringify(first)));
  assert.deepEqual(Object.keys(process.env), Object.keys(env));
  for (const name of Object.keys(env))
    assert.ok(process.env[name] === env[name], 'Catalog changed environment variable ' + name);
  assert.equal(bridge.pool.instances.size, 0);
  assert.deepEqual(await fs.readdir(f.config.sessionRoots[0]), []);
  assert.deepEqual(await fs.readdir(f.config.stateDir), ['ipc']);
  assert.equal((await bridge.models({ offset: 32, limit: 1 })).models[0].id, '32');
  assert.equal((await bridge.models({ offset: 33 })).next_offset, null);

  await savedSession(bridge);
  for (const [object, methods] of [
    [bridge, ['session', 'sessions']],
    [bridge.pool, ['forRead', 'resolve', 'get']],
  ])
    for (const method of methods)
      t.mock.method(object, method, () => {
        throw Error('SESSION_OBSERVATION');
      });
  assert.deepEqual(await bridge.models({}), first);
  assert.equal(await f.calls(), 'catalog\ncatalog\ncatalog\ncatalog\n');
});

test('native stored credentials unlock cached models without changing auth/cache content or metadata', async (t) => {
  const f = await fixture(t),
    agent = f.config.piRuntime.agentDir,
    authFile = path.join(agent, 'auth.json'),
    cacheFile = path.join(agent, 'models-store.json');
  const cache = JSON.stringify({
    openrouter: {
      models: [
        {
          provider: 'openrouter',
          id: 'cached-only-model',
          type: 'chat',
          api: 'openai-completions',
          name: 'Cached model',
          input: ['text'],
          reasoning: false,
          contextWindow: 16000,
          maxTokens: 2048,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
      checkedAt: Date.now(),
      etag: '"synthetic-cache"',
    },
  });
  await fs.writeFile(cacheFile, cache, { mode: 0o640 });
  const query = () => f.bridge.models({ limit: 100 });
  const withoutAuth = await query();
  assert.equal(
    withoutAuth.models.some((model) => model.id === 'cached-only-model'),
    false,
  );
  await assert.rejects(fs.stat(authFile), { code: 'ENOENT' });
  const auth = JSON.stringify({
    openrouter: { type: 'api_key', key: 'SYNTHETIC_STORED_CREDENTIAL' },
  });
  await fs.writeFile(authFile, auth, { mode: 0o600 });
  const metadata = async (file) => {
    const { mtimeNs, ctimeNs, mode } = await fs.stat(file, { bigint: true });
    return { mtimeNs, ctimeNs, mode };
  };
  const files = [authFile, cacheFile],
    contents = [auth, cache],
    before = await Promise.all(files.map(metadata)),
    entries = await fs.readdir(agent);
  const page = await query();
  assert.equal(page.models.length, 34);
  assert.deepEqual(
    page.models.find((model) => model.id === 'cached-only-model')?.provider,
    'openrouter',
  );
  assert.ok(!JSON.stringify(page).includes('SYNTHETIC_STORED_CREDENTIAL'));
  assert.deepEqual(await fs.readdir(agent), entries);
  assert.deepEqual(await Promise.all(files.map(metadata)), before);
  for (const [i, file] of files.entries())
    assert.ok(
      (await fs.readFile(file, 'utf8')) === contents[i],
      'Synthetic storage content changed',
    );
});

test('catalog accepts effective project or known-session execution rights, with normal override priority', async (t) => {
  const f = await fixture(t),
    made = await savedSession(f.bridge);
  t.mock.method(f.bridge.pool, 'forRead', () => assert.fail('catalog must not bind an owner'));
  for (const grants of [
    [],
    [{ session_id: 'missing', send: true }],
    [{ folder: f.project, read: true }],
    [
      { session_id: made.session_id, send: true },
      { session_id: made.session_id, send: false },
    ],
  ]) {
    await f.policy(grants);
    await assert.rejects(f.bridge.models({}), /NOT_FOUND_OR_DENIED/);
  }
  await f.policy(
    f.config.folders.map((folder) => ({ folder: folder.path, send: false })),
    { ...f.config.defaults, send: true },
  );
  await assert.rejects(f.bridge.models({}), /NOT_FOUND_OR_DENIED/);
  assert.equal(await f.calls(), '');
  for (const grants of [
    [{ session_id: made.session_id, send: true }],
    [{ folder: f.project, command: true }],
    [{ folder: f.project, create: true }],
    [{ folder: f.config.folders[1].path, send: true }],
  ]) {
    await f.policy(grants);
    assert.equal((await f.bridge.models({})).models.length, 30);
  }
  assert.equal(f.bridge.pool.instances.size, 0);
});
