import { readSource } from './fixtures/read-source.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';

import { ownedRuntime } from './fixtures/owned-runtime.mjs';

async function fixture(t, grants, factory) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-bridge-test-'));
  const cwd = path.join(dir, 'project'),
    child = path.join(cwd, 'child');
  await fs.mkdir(child, { recursive: true });
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    piRuntime: { agentDir: path.join(dir, 'agent'), inheritEnv: [] },
    piArgs: ['--session-dir', path.join(dir, 'sessions')],
    folders: [{ path: cwd }, { path: child }],
    grants: grants?.(cwd, child) ?? [
      { folder: cwd, list: true, read: true, send: true, delete: true, create: true },
    ],
  };
  const runtime = ownedRuntime({
    alive: true,
    calls: [],
    resumes: 0,
    state: async () => ({ isStreaming: false, isCompacting: false }),
    hasPendingAdmission: () => false,
    hasUnsettledWork: () => false,
    idleSnapshot: async function () {
      const state = await this.state();
      return { state, status: state.isStreaming ? 'busy' : 'idle' };
    },
    command: async function (c) {
      this.calls.push(c);
      return { disposition: 'started' };
    },
    stop: async function () {
      this.alive = false;
    },
  });
  const bridge = await new Bridge(
    config,
    factory ??
      (async () => {
        runtime.resumes++;
        runtime.alive = true;
        return runtime;
      }),
  ).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const created = await savedSession(bridge);
  return { bridge, config, dir, cwd, child, runtime, id: created.session_id, created };
}
async function append(f, entries) {
  const [s] = await f.bridge.sessions();
  await fs.appendFile(
    s.file,
    entries.map((e) => JSON.stringify({ timestamp: new Date().toISOString(), ...e })).join('\n') +
      '\n',
  );
  return s.file;
}

test('send-only permission cannot disclose metadata or bodies', async (t) => {
  const f = await fixture(t, (cwd) => [{ folder: cwd, create: true, send: true }]);
  await append(f, [
    { type: 'session_info', id: 'title', parentId: null, name: 'secret-project-name' },
  ]);
  assert.deepEqual((await f.bridge.list()).sessions, []);
  assert.deepEqual((await f.bridge.list({ name: 'secret' })).sessions, []);
  await assert.rejects(readSource(f.bridge, { session_id: f.id }), /NOT_FOUND_OR_DENIED/);
  const receipt = await f.bridge.send({
    session_id: f.id,
    text: 'own-input',
  });
  assert.ok(['started', 'queued', 'handled'].includes(receipt.status), JSON.stringify(receipt));
  assert.equal(JSON.stringify(receipt).includes('secret'), false);
});

test('delete preparation failure leaves an owned runtime alive and creates no restore intent', async (t) => {
  const f = await fixture(t);
  await f.bridge.send({ session_id: f.id, text: 'fixture' });
  await fs.mkdir(path.join(f.config.stateDir, 'trash'), { mode: 0o755 });
  await fs.chmod(path.join(f.config.stateDir, 'trash'), 0o755);
  const result = await f.bridge.delete({ session_id: f.id });
  assert.equal(result.status, 'rejected');
  assert.equal(f.runtime.alive, true);
  assert.deepEqual(await fs.readdir(path.join(f.config.stateDir, 'trash')), []);
  assert.deepEqual(await fs.readdir(path.join(f.config.sessionRoots[0], '.pi-mcp-trash')), []);
  assert.equal((await f.bridge.list()).sessions.length, 1);
});

test('name filtering scans list-authorized metadata until its page and one extra match', async (t) => {
  const f = await fixture(t);
  for (let i = 1; i < 6; i++) await savedSession(f.bridge);
  const sessions = await f.bridge.sessions(),
    files = new Set(sessions.map((s) => s.file)),
    seen = [];
  for (const [i, s] of sessions.entries()) {
    await fs.appendFile(
      s.file,
      JSON.stringify({
        type: 'session_info',
        id: 'title',
        parentId: null,
        name: i === 2 ? 'unrelated' : `needle ${i}`,
      }) + '\n',
    );
    await fs.utimes(s.file, 10000 - i, 10000 - i);
  }
  f.config.grants.push({ session_id: sessions[1].id, list: false });
  const original = fsSync.createReadStream;
  t.mock.method(fsSync, 'createReadStream', (...args) => {
    if (files.has(args[0])) seen.push(args[0]);
    return original(...args);
  });
  syncBuiltinESMExports();
  const check = async (args, expectedRows, expectedReads, next) => {
    seen.length = 0;
    const result = await f.bridge.list({ name: 'needle', limit: 1, ...args });
    assert.deepEqual(
      result.sessions.map((s) => s.session_id),
      expectedRows.map((i) => sessions[i].id),
    );
    assert.equal(result.next_offset, next);
    assert.deepEqual(
      seen,
      expectedReads.map((i) => sessions[i].file),
    );
  };
  try {
    await check({}, [0], [0, 2, 3], 1); // One nonmatch; unreadable title is never parsed.
    await check({ offset: 1 }, [3], [4], 2); // Reuse unchanged authorized titles.
    await check({ offset: 3 }, [5], [5], null);
    await check({ offset: 4 }, [], [], null);
    await check({ name: 'absent' }, [], [], null);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('live names share the status snapshot without scanning growing saved history', async (t) => {
  const f = await fixture(t),
    session = await f.bridge.session(f.id),
    seen = [];
  await append(f, [{ type: 'session_info', id: 'saved-name', parentId: null, name: 'disk name' }]);
  f.config.grants.push({ session_id: f.id, read: false });
  await f.bridge.pool.resolve(session);
  let name = 'live name',
    states = 0;
  f.runtime.state = async () => {
    states++;
    return { sessionName: name, isStreaming: true, pendingMessageCount: 0 };
  };
  const original = fsSync.createReadStream;
  t.mock.method(fsSync, 'createReadStream', (...args) => {
    if (args[0] === session.file) seen.push(args[0]);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const current of ['live name', 'renamed', null]) {
      name = current;
      await fs.appendFile(
        session.file,
        JSON.stringify({
          type: 'custom',
          id: String(states),
          parentId: null,
          data: 'more history',
        }) + '\n',
      );
      const [row] = (await f.bridge.list()).sessions;
      assert.equal(row.name, current);
      assert.equal(row.status.state, 'busy');
    }
    assert.equal(states, 3);
    assert.deepEqual(seen, []);
    f.runtime.alive = false;
    assert.equal((await f.bridge.list()).sessions[0].name, 'disk name');
    assert.equal(seen.length, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('an admitted list finishes its observation after admission closes, while new queries are refused', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  t.after(() => release.resolve());
  f.runtime.state = async () => {
    entered.resolve();
    await release.promise;
    return { sessionName: 'CAPTURED_TITLE', isIdle: true };
  };
  f.bridge.pool.instances.set(f.id, f.runtime);
  const listing = f.bridge.list({ session_id: f.id });
  await entered.promise;
  await f.bridge.prepareClose();
  release.resolve();
  const result = await listing;
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].name, 'CAPTURED_TITLE');
  await assert.rejects(f.bridge.list({ session_id: f.id }), /BRIDGE_CLOSING/);
});
