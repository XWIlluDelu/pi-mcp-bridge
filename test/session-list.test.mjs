import { nativeOwner } from './fixtures/native-owner.mjs';
import { append } from './fixtures/native-history.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

import { ownedRuntime } from './fixtures/owned-runtime.mjs';

async function fixture(t) {
  const runtime = ownedRuntime({
    state: async () => ({ isIdle: true }),
    command: async () => ({ disposition: 'started' }),
    async stop() {
      this.alive = false;
    },
  });
  const f = await nativeOwner(t, { prefix: 'session-list', factory: async () => runtime });
  return { ...f, runtime };
}

function scanHistory(t, files) {
  const seen = [],
    original = fsSync.createReadStream;
  t.mock.method(fsSync, 'createReadStream', (...args) => {
    if (files.has(args[0])) seen.push(args[0]);
    return original(...args);
  });
  syncBuiltinESMExports();
  return {
    seen,
    restore() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

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
    scans = scanHistory(t, new Set(sessions.map((s) => s.file)));
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
  const { seen, restore } = scans;
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
    restore();
  }
});

test('live names share the status snapshot without scanning growing saved history', async (t) => {
  const f = await fixture(t),
    { session } = f;
  await append(session, [
    { type: 'session_info', id: 'saved-name', parentId: null, name: 'disk name' },
  ]);
  f.config.grants.push({ session_id: f.id, read: false });
  await f.bridge.pool.resolve(session);
  let name = 'live name',
    states = 0;
  f.runtime.state = async () => {
    states++;
    return { sessionName: name, isStreaming: true, pendingMessageCount: 0 };
  };
  const { seen, restore } = scanHistory(t, new Set([session.file]));
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
    restore();
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
