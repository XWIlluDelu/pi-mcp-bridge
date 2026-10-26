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
import { loadSavedSession } from '../src/data.mjs';
import { permitted } from '../src/permissions.mjs';
import { RpcFailure } from '../src/rpc.mjs';
import { readClaim, reserveOwner } from '../src/attachments.mjs';
import { SessionManager } from './fixtures/pi.mjs';

test('listing respects the latest native title including an explicit clear', async (t) => {
  const f = await fixture(t),
    saved = await f.bridge.session(f.id),
    manager = SessionManager.open(saved.file);
  manager.appendSessionInfo(' OLD_TITLE ');
  assert.equal((await f.bridge.list()).sessions[0].name, manager.getSessionName());
  manager.appendSessionInfo('  ');
  assert.equal(manager.getSessionName(), undefined);
  assert.equal((await f.bridge.list()).sessions[0].name, null);
  assert.deepEqual((await f.bridge.list({ name: 'OLD_TITLE' })).sessions, []);
});

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
  const runtime = {
    alive: true,
    calls: [],
    resumes: 0,
    state: async () => ({ isStreaming: false, isCompacting: false }),
    command: async function (c) {
      this.calls.push(c);
      return { disposition: 'started' };
    },
    stop: async function () {
      this.alive = false;
    },
  };
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

test('permissions: most specific, recent explicit field, unset inherits, final deny', () => {
  const c = {
    grants: [
      { folder: '/project', list: true, read: true, send: true },
      { folder: '/project/child', read: false },
      { folder: '/project', send: false },
      { session_id: 's', list: true, read: true },
      { session_id: 's', read: null },
    ],
  };
  assert.equal(permitted(c, 'read', { id: 's', cwd: '/project/child' }), false);
  assert.equal(permitted(c, 'send', { id: 's', cwd: '/project/child' }), false);
  assert.equal(permitted(c, 'read', { id: 'other', cwd: '/project2' }), false);
  c.grants.push({ session_id: 's', list: true, read: true });
  assert.equal(permitted(c, 'read', { id: 's', cwd: '/project/child' }), true);
  assert.equal(permitted(c, 'delete', { id: 's', cwd: '/project' }), false);
});

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
test('saved idle_only resumes first; process reused', async (t) => {
  const f = await fixture(t);
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'hello',
          mode: 'idle_only',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  await f.bridge.send({ session_id: f.id, text: 'again' });
  assert.equal(f.runtime.resumes, 1);
  assert.equal(f.runtime.calls.length, 2);
});
test('idle_only skips busy while native and strategy modes retain Pi semantics', async (t) => {
  const f = await fixture(t);
  f.runtime.state = async () => ({ isStreaming: true });
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: 'x', mode: 'idle_only' })).status,
    'skipped',
  );
  assert.equal(f.runtime.calls.length, 0);
  await f.bridge.send({ session_id: f.id, text: 'x' });
  await f.bridge.send({ session_id: f.id, text: 'x', mode: 'follow_up' });
  assert.deepEqual(
    f.runtime.calls.map((c) => c.streamingBehavior),
    ['steer', 'followUp'],
  );
  await assert.rejects(
    f.bridge.send({ session_id: f.id, text: 'x', mode: 'unknown' }),
    /INVALID_ARGUMENTS/,
  );
  assert.equal(f.runtime.calls.length, 2);
});

test('independent concurrent calls all submit even with identical payloads', async (t) => {
  const f = await fixture(t);
  const args = { session_id: f.id, text: 'hello' };
  const r = await Promise.all(Array.from({ length: 10 }, () => f.bridge.send(args)));
  assert.equal(f.runtime.calls.length, 10);
  assert.ok(r.every((result) => result.status === 'started'));

  await f.bridge.send({ ...args });
  assert.equal(f.runtime.calls.length, 11);
});

test('context edits and branch selection; raw remains distinct; read does not write', async (t) => {
  const f = await fixture(t);
  const file = await append(f, [
    {
      type: 'message',
      id: 'a',
      parentId: null,
      message: { role: 'user', content: 'original-secret' },
    },
    {
      type: 'message',
      id: 'abandoned',
      parentId: 'a',
      message: { role: 'user', content: 'other-branch' },
    },
    {
      type: 'context_edit',
      id: 'edit',
      parentId: 'a',
      targetId: 'a',
      replacement: { content: 'replacement' },
    },
  ]);
  const before = await fs.readFile(file, 'utf8');
  const read = await readSource(f.bridge, { session_id: f.id });
  assert.equal(read.items[0].message.content, 'replacement');
  assert.equal(JSON.stringify(read).includes('original-secret'), false);
  assert.equal(JSON.stringify(read).includes('other-branch'), false);
  assert.equal((await loadSavedSession(await f.bridge.session(f.id))).entries.length, 3);
  await assert.rejects(
    readSource(f.bridge, { session_id: f.id, leaf_id: 'missing' }),
    /ENTRY_NOT_FOUND/,
  );
  assert.equal(await fs.readFile(file, 'utf8'), before);
});
test('compaction preserves checkpoint and kept context; existing summary only', async (t) => {
  const f = await fixture(t);
  await append(f, [
    {
      type: 'message',
      id: 'a',
      parentId: null,
      message: { role: 'user', content: 'summarized-old' },
    },
    { type: 'message', id: 'b', parentId: 'a', message: { role: 'user', content: 'kept' } },
    {
      type: 'compaction',
      id: 'c',
      parentId: 'b',
      summary: 'existing summary',
      firstKeptEntryId: 'b',
      tokensBefore: 10,
      systemMessage: { role: 'system', content: 'checkpoint' },
    },
  ]);
  const r = await readSource(f.bridge, {
    session_id: f.id,
    range: { recent: 3 },
    content: { system: true },
  });
  assert.equal(r.items[0].message.role, 'system');
  assert.equal(JSON.stringify(r).includes('summarized-old'), false);
  assert.equal(JSON.stringify(r).includes('kept'), true);
  assert.equal(
    r.items.find((x) => x.type === 'summary').parts[0].message.summary,
    'existing summary',
  );
});
test('summaries follow the selected leaf and exclude superseded checkpoints retained in the raw range', async (t) => {
  const f = await fixture(t);
  const file = await append(f, [
    {
      type: 'message',
      id: 'a',
      parentId: null,
      message: { role: 'user', content: 'old requirement' },
    },
    {
      type: 'compaction',
      id: 'c1',
      parentId: 'a',
      summary: 'old checkpoint',
      firstKeptEntryId: 'a',
      tokensBefore: 10,
    },
    {
      type: 'message',
      id: 'b',
      parentId: 'c1',
      message: { role: 'user', content: 'retained requirement' },
    },
    {
      type: 'compaction',
      id: 'c2',
      parentId: 'b',
      summary: 'new checkpoint',
      firstKeptEntryId: 'c1',
      tokensBefore: 20,
    },
    {
      type: 'message',
      id: 'later',
      parentId: 'c2',
      message: { role: 'user', content: 'newer decision after checkpoint' },
    },
  ]);
  const before = await fs.readFile(file, 'utf8');
  const current = await readSource(f.bridge, { session_id: f.id, range: { recent: 3 } });
  const summaryParts = (read) =>
    read.items.filter((x) => x.type === 'summary').flatMap((x) => x.parts);
  assert.deepEqual(
    summaryParts(current).map((x) => x.source.entry_id),
    ['c2'],
  );
  assert.equal(current.leaf_id, 'later');
  assert.equal(summaryParts(current)[0].message.summary, 'new checkpoint');
  const earlier = await readSource(f.bridge, {
    session_id: f.id,
    range: { recent: 3 },
    leaf_id: 'b',
  });
  assert.deepEqual(
    summaryParts(earlier).map((x) => x.source.entry_id),
    ['c1'],
  );
  assert.equal(earlier.leaf_id, 'b');
  assert.deepEqual((await readSource(f.bridge, { session_id: f.id, leaf_id: null })).items, []);
  const raw = await loadSavedSession(await f.bridge.session(f.id));
  assert.equal(raw.entries.find((e) => e.id === 'c2').firstKeptEntryId, 'c1');
  assert.equal(raw.entries.find((e) => e.id === 'c1').summary, 'old checkpoint');
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(f.runtime.calls.length, 0);
});
test('summaries omit a context-hidden branch summary but retain its original raw source', async (t) => {
  const f = await fixture(t);
  await append(f, [
    {
      type: 'message',
      id: 'a',
      parentId: null,
      message: { role: 'user', content: 'public fixture' },
    },
    {
      type: 'branch_summary',
      id: 'branch',
      parentId: 'a',
      fromId: 'a',
      summary: 'branch checkpoint',
    },
    { type: 'context_edit', id: 'hide', parentId: 'branch', targetId: 'branch', replacement: null },
  ]);
  const current = await readSource(f.bridge, { session_id: f.id, range: { recent: 3 } });
  assert.ok(!current.items.some((x) => x.type === 'summary'));
  const earlier = await readSource(f.bridge, {
    session_id: f.id,
    range: { recent: 3 },
    leaf_id: 'branch',
  });
  assert.equal(
    earlier.items.find((x) => x.type === 'summary').parts[0].message.summary,
    'branch checkpoint',
  );
  const raw = await loadSavedSession(await f.bridge.session(f.id));
  assert.equal(raw.entries.find((x) => x.id === 'branch').summary, 'branch checkpoint');
});
test('selected context leaf metadata matches projected branch, including empty context', async (t) => {
  const f = await fixture(t);
  await append(f, [
    { type: 'message', id: 'a', parentId: null, message: { role: 'user', content: 'branch-a' } },
    { type: 'message', id: 'b', parentId: null, message: { role: 'user', content: 'branch-b' } },
  ]);
  const selected = await readSource(f.bridge, { session_id: f.id, leaf_id: 'a' });
  assert.equal(selected.leaf_id, 'a');
  assert.equal(selected.items[0].message.content, 'branch-a');
  const empty = await readSource(f.bridge, { session_id: f.id, leaf_id: null });
  assert.equal(empty.leaf_id, null);
  assert.deepEqual(empty.items, []);
  assert.equal((await loadSavedSession(await f.bridge.session(f.id))).leafId, 'b');
});
test('delete stops active process, moves to recoverable trash, leaves project alone', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, 'keep.txt'), 'untouched');
  await f.bridge.send({ session_id: f.id, text: 'hello' });
  const r = await f.bridge.delete({ session_id: f.id });
  assert.equal(r.status, 'deleted');
  assert.equal(f.runtime.alive, false);
  assert.equal((await f.bridge.list()).sessions.length, 0);
  assert.equal(await fs.readFile(path.join(f.cwd, 'keep.txt'), 'utf8'), 'untouched');
  const metadata = JSON.parse(
    await fs.readFile(
      path.join(f.config.stateDir, 'trash', `${r.restore_token}.restore.json`),
      'utf8',
    ),
  );
  assert.ok((await fs.stat(metadata.trash_path)).size > 0);

  assert.equal(metadata.session_id, f.id);
  await fs.rename(metadata.trash_path, metadata.original_path);
  assert.equal((await f.bridge.list()).sessions[0].session_id, f.id);
});
test('create survives a bridge restart without automatically repeating work', async (t) => {
  const f = await fixture(t),
    created = await f.bridge.create({
      project: f.cwd,
      text: 'first',
    });
  await f.bridge.close();
  const fresh = await new Bridge(f.config).init();
  try {
    assert.equal((await fresh.list()).sessions.length, 2);
  } finally {
    await fresh.close();
  }
});

test('empty sessionRoots is rejected at startup instead of failing later during create', async (t) => {
  const f = await fixture(t);
  const invalid = new Bridge({
    ...f.config,
    stateDir: path.join(f.dir, 'invalid-state'),
    sessionRoots: [],
  });
  await assert.rejects(invalid.init(), /INVALID_OWNER_CONFIG/);
  await assert.rejects(fs.stat(path.join(f.dir, 'invalid-state')), { code: 'ENOENT' });
});

test('changed native header identity produces a new opaque ID and cannot reuse old runtime', async (t) => {
  const f = await fixture(t);
  await f.bridge.send({ session_id: f.id, text: 'fixture' });
  assert.equal(f.runtime.resumes, 1);
  const original = await f.bridge.session(f.id);
  await fs.writeFile(
    original.file,
    JSON.stringify({ ...original.header, id: 'replacement-native-id' }) + '\n',
  );
  await assert.rejects(readSource(f.bridge, { session_id: f.id }), /NOT_FOUND_OR_DENIED/);
  const rejected = await f.bridge.send({
    session_id: f.id,

    text: 'fixture',
  });
  assert.equal(rejected.status, 'rejected');
  assert.equal(f.runtime.resumes, 1);
  const [replacement] = (await f.bridge.list()).sessions;
  assert.notEqual(replacement.session_id, f.id);
  await f.bridge.send({
    session_id: replacement.session_id,

    text: 'fixture',
  });
  assert.equal(f.runtime.resumes, 2);
});

test('recorded project history remains listed while a symlink cannot redirect cold execution', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.dir, 'outside');
  await fs.mkdir(outside);
  const link = path.join(f.cwd, 'alias');
  await fs.symlink(outside, link, 'dir');
  const [s] = await f.bridge.sessions();
  s.header.cwd = link;
  await fs.writeFile(s.file, JSON.stringify(s.header) + '\n');
  const listed = (await f.bridge.list()).sessions;
  assert.deepEqual(
    listed.map(({ session_id, project }) => ({ session_id, project })),
    [{ session_id: f.id, project: link }],
  );
  assert.equal((await f.bridge.session(f.id)).cwd, null);
  const rejected = await f.bridge.send({ session_id: f.id, text: 'hello' });
  assert.match(rejected.submission_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(rejected, {
    status: 'rejected',
    reason: 'EXECUTION_CWD_UNAVAILABLE',
    submission_id: rejected.submission_id,
  });
  assert.equal(f.runtime.resumes, 0);
  assert.deepEqual(f.runtime.calls, []);
});

test('invalid transcript trees retain identity but content reads reject', async (t) => {
  const f = await fixture(t);
  const [s] = await f.bridge.sessions();
  await fs.appendFile(
    s.file,
    JSON.stringify({
      type: 'message',
      id: 'cycle',
      parentId: 'cycle',
      message: { role: 'user', content: 'x' },
    }) + '\n',
  );
  assert.equal((await f.bridge.list()).sessions[0].session_id, f.id);
  await assert.rejects(readSource(f.bridge, { session_id: f.id }), /INVALID_SESSION_TREE/);
});

test('oversized entry IDs cannot bypass read response bounds', async (t) => {
  const f = await fixture(t);
  await append(f, [
    {
      type: 'message',
      id: 'x'.repeat(100000),
      parentId: null,
      message: { role: 'user', content: 'test' },
    },
  ]);
  assert.equal((await f.bridge.list()).sessions[0].session_id, f.id);
  await assert.rejects(readSource(f.bridge, { session_id: f.id }), /INVALID_SESSION_TREE/);
});

test('overlapping bridge state and session storage is rejected', async (t) => {
  const f = await fixture(t);
  await f.bridge.close();
  f.config.stateDir = path.join(f.config.sessionRoots[0], 'state');
  await assert.rejects(new Bridge(f.config).init(), /OVERLAPPING_STORAGE/);
});

test('shutdown rejects new work and drains an admitted send before closing its runtime', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.runtime.command = async () => {
    entered.resolve();
    await release.promise;
    return { disposition: 'started' };
  };
  const sending = f.bridge.send({ session_id: f.id, text: 'admitted' });
  await entered.promise;
  let closed = false;
  const closing = f.bridge.close().then(() => {
    closed = true;
  });
  await assert.rejects(f.bridge.send({ session_id: f.id, text: 'too late' }), /BRIDGE_CLOSING/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release.resolve();
  const sent = await sending;
  assert.match(sent.submission_id, /^[a-f0-9-]{36}$/);
  assert.deepEqual(sent, { status: 'started', submission_id: sent.submission_id });
  await closing;
  assert.equal(f.runtime.alive, false);
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

test('delete rename failure cleans intents while post-move sync failure preserves recoverability', async (t) => {
  for (const phase of ['rename', 'sync']) {
    const f = await fixture(t),
      session = await f.bridge.session(f.id);
    await f.bridge.releaseForLocal({ session_id: f.id });
    const pause = await readClaim(f.bridge.pool.attachmentDir, session);
    assert.equal(pause.noColdReacquire, true);
    let moved = false;
    const rename = fs.rename,
      open = fs.open;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (from === session.file) {
        if (phase === 'rename') throw Object.assign(new Error('fixture'), { code: 'EXDEV' });
        await rename(from, to);
        moved = true;
        return;
      }
      return rename(from, to);
    });
    t.mock.method(fs, 'open', async (file, ...args) => {
      const fd = await open(file, ...args);
      if (moved && file === path.join(path.dirname(session.file), '.pi-mcp-trash'))
        fd.sync = async () => {
          throw Object.assign(new Error('fixture'), { code: 'EIO' });
        };
      return fd;
    });
    let result;
    try {
      result = await f.bridge.delete({ session_id: f.id });
    } finally {
      t.mock.restoreAll();
    }
    const intents = await fs.readdir(path.join(f.config.stateDir, 'trash'));
    if (phase === 'rename') {
      assert.equal(result.status, 'rejected');
      assert.deepEqual(intents, []);
      assert.ok(await fs.stat(session.file));
      assert.deepEqual(await readClaim(f.bridge.pool.attachmentDir, session), pause);
      await assert.rejects(
        reserveOwner(f.bridge.pool.attachmentDir, session, 'rpc'),
        /COLD_REACQUIRE_BLOCKED/,
      );
    } else {
      assert.equal(result.status, 'unknown');
      assert.deepEqual(intents, [result.restore_token + '.restore.json']);
      assert.equal(result.recoverable, true);
      assert.equal(await readClaim(f.bridge.pool.attachmentDir, session), null);
      const metadata = JSON.parse(
        await fs.readFile(path.join(f.config.stateDir, 'trash', intents[0]), 'utf8'),
      );
      assert.ok(await fs.stat(metadata.trash_path));
      assert.ok(await fs.stat(metadata.metadata_path));
      await assert.rejects(fs.stat(session.file), { code: 'ENOENT' });
    }
  }
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

test('unfiltered list reads only its page and metadata does not depend on read', async (t) => {
  const f = await fixture(t);
  await savedSession(f.bridge);
  const sessions = await f.bridge.sessions(),
    files = new Set(sessions.map((s) => s.file)),
    seen = [];
  for (const [i, s] of sessions.entries()) await fs.utimes(s.file, 10000 - i, 10000 - i);
  const original = fsSync.createReadStream;
  t.mock.method(fsSync, 'createReadStream', (...args) => {
    if (files.has(args[0])) seen.push(args[0]);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    const first = await f.bridge.list({ limit: 1 });
    assert.equal(first.sessions.length, 1);
    assert.equal(first.next_offset, 1);
    assert.deepEqual(seen, [sessions[0].file]);
    seen.length = 0;
    const second = await f.bridge.list({ limit: 1, offset: first.next_offset });
    assert.equal(second.next_offset, null);
    assert.deepEqual(seen, [sessions[1].file]);
    seen.length = 0;
    await f.bridge.list({ name: 'project', limit: 1 });
    assert.equal(seen.length, 0); // Both titles were already read on earlier pages.
    f.config.grants.push({ session_id: sessions[1].id, read: false });
    seen.length = 0;
    assert.equal(
      (await f.bridge.list({ limit: 1, offset: 1 })).sessions[0].session_id,
      sessions[1].id,
    );
    assert.deepEqual(seen, []);
    f.config.grants.push({ session_id: sessions[1].id, list: false });
    seen.length = 0;
    await f.bridge.list({ name: 'project' });
    assert.deepEqual(seen, []);
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

test(
  'name-filter live state lookup is bounded, concurrent and consumed in sorted order',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    for (let i = 1; i < 9; i++) await savedSession(f.bridge);
    const sessions = await f.bridge.sessions(),
      entered = [],
      gates = sessions.map(() => Promise.withResolvers()),
      started = Promise.withResolvers();
    t.after(() => gates.forEach((g) => g.resolve()));
    for (const [index, session] of sessions.entries()) {
      await fs.utimes(session.file, 10000 - index, 10000 - index);
      f.bridge.pool.instances.set(session.id, {
        alive: true,
        state: async () => {
          entered.push(index);
          if (entered.length === 4) started.resolve();
          await gates[index].promise;
          return { sessionName: 'needle ' + index };
        },
        stop: async () => {},
      });
    }
    const listing = f.bridge.list({ name: 'needle', offset: 1, limit: 1 });
    await started.promise;
    assert.deepEqual(
      entered.toSorted((a, b) => a - b),
      [0, 1, 2, 3],
    );
    gates[3].resolve();
    gates[1].resolve();
    gates[0].resolve();
    gates[2].resolve();
    const result = await listing;
    assert.deepEqual(
      result.sessions.map((s) => s.session_id),
      [sessions[1].id],
    );
    assert.equal(result.next_offset, 2);
    assert.ok(
      entered.length <= 6,
      'stop after one extra matching row, with at most three speculative observations',
    );
  },
);

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
