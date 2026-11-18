import { nativeOwner } from './fixtures/native-owner.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';

import { discover, loadSession } from '../src/data.mjs';
import { reserveOwner, releaseOwner } from '../src/attachments.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { SessionManager } from './fixtures/pi.mjs';
import { readClaim, AttachedRuntime } from '../src/attachments.mjs';
import { companionHooks } from './fixtures/companion.mjs';

const fixture = (t) => nativeOwner(t, { prefix: 'alias' });
const sessionAt = (manager) => ({ file: manager.getSessionFile(), header: manager.getHeader() });
const persist = (manager) =>
  manager.appendMessage({
    role: 'user',
    content: 'native persistence fixture',
    timestamp: Date.now(),
  });

function context(manager, mode = 'tui') {
  const ctx = {
    mode,
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    stopped: false,
    shutdown: () => {
      ctx.stopped = true;
    },
  };
  return ctx;
}

test('changing a native ID at the same path cannot hide a live writer', async (t) => {
  const { config, session } = await fixture(t);
  const claim = await reserveOwner(config.attachmentDir, session, 'tui');
  await fs.writeFile(session.file, JSON.stringify({ ...session.header, id: 'replacement' }) + '\n');
  const [changed] = await discover(config);
  assert.notEqual(changed.id, session.id);
  const rpc = new PiRpc(config, changed);
  await assert.rejects(rpc.start(), /LIVE_OWNER_UNREACHABLE/);
  assert.equal(rpc.child, undefined);
  assert.equal((await readClaim(config.attachmentDir, session)).generation, claim.generation);
  await releaseOwner(config.attachmentDir, session, claim);
  await reserveOwner(config.attachmentDir, changed, 'rpc');
});

test('initial attachment rechecks first persistence after a missing-file snapshot', async (t) => {
  const f = await fixture(t),
    handlers = await companionHooks(f);
  const manager = SessionManager.create(f.cwd, f.config.sessionRoots[0]);
  const session = sessionAt(manager),
    ctx = context(manager),
    realLstat = fs.lstat;
  let raced = false;
  t.mock.method(fs, 'lstat', async function (target, ...args) {
    try {
      return await realLstat.call(fs, target, ...args);
    } catch (error) {
      if (target === session.file && error.code === 'ENOENT' && !raced) {
        raced = true;
        persist(manager);
      }
      throw error;
    }
  });
  try {
    await handlers.session_start({}, ctx);
    const claim = await readClaim(f.config.attachmentDir, session);
    assert.equal(raced, true);
    assert.equal(ctx.stopped, false);
    assert.equal(claim.phase, 'ready');
    assert.equal(
      (await new AttachedRuntime(f.config, session, claim).state()).sessionId,
      session.header.id,
    );
  } finally {
    t.mock.restoreAll();
  }
});

for (const persisted of [false, true])
  test(`independent managers at the same path stay distinct ${persisted ? 'after' : 'before'} first persistence`, async (t) => {
    const f = await fixture(t),
      a = await companionHooks(f),
      b = await companionHooks(f);
    const first = SessionManager.create(f.cwd, f.config.sessionRoots[0]);
    if (persisted) persist(first);
    const second = SessionManager.open(first.getSessionFile());
    assert.equal(first.getSessionId() === second.getSessionId(), persisted);
    const ctxA = context(first),
      ctxB = context(second),
      sessionA = sessionAt(first);
    const claim = () => readClaim(f.config.attachmentDir, sessionA);
    await a.session_start({}, ctxA);
    const { generation } = await claim();
    persist(second);
    await assert.rejects(b.session_start({ reason: 'startup' }, ctxB), /LIVE_OWNER_UNREACHABLE/);
    assert.equal(ctxB.stopped, true);
    if (!persisted) assert.equal(await readClaim(f.config.attachmentDir, sessionAt(second)), null);
    assert.equal((await claim()).generation, generation);
    if (persisted) {
      await a.session_shutdown({ reason: 'reload' });
      await assert.rejects(b.session_start({ reason: 'reload' }, ctxB), /LIVE_OWNER_UNREACHABLE/);
      await a.session_start({ reason: 'reload' }, ctxA);
      assert.notEqual((await claim()).generation, generation);
    }
  });

test('hardlink aliases are hidden and stale discovered targets cannot claim or spawn', async (t) => {
  const f = await fixture(t),
    alias = path.join(f.config.sessionRoots[0], 'alias.jsonl');
  await fs.link(f.session.file, alias);
  assert.equal((await fs.stat(alias)).ino, (await fs.stat(f.session.file)).ino);
  assert.deepEqual(await discover(f.config), []);
  await assert.rejects(loadSession(alias), /SESSION_FILE_ALIAS_NOT_ALLOWED/);
  const rpc = new PiRpc(f.config, f.session);
  await assert.rejects(rpc.start(), /SESSION_FILE_ALIAS_NOT_ALLOWED/);
  assert.equal(rpc.child, undefined);
  await fs.unlink(alias);
  assert.equal((await f.bridge.sessions())[0].id, f.session.id);
});

test('native unflushed startup and /new reserve their paths and validate after persistence', async (t) => {
  const f = await fixture(t),
    handlers = await companionHooks(f);
  let previousSessionFile;
  for (const reason of ['startup', 'new']) {
    if (previousSessionFile) await handlers.session_shutdown({ reason });
    const manager = SessionManager.create(f.cwd, f.config.sessionRoots[0]);
    const session = sessionAt(manager),
      ctx = context(manager);
    await assert.rejects(fs.stat(session.file), { code: 'ENOENT' });
    await handlers.session_start({ reason, previousSessionFile }, ctx);
    previousSessionFile = session.file;
    const claim = await readClaim(f.config.attachmentDir, session);
    assert.equal(claim.phase, 'ready');
    const runtime = new AttachedRuntime(f.config, session, claim);
    assert.equal((await runtime.state()).sessionId, session.header.id);
    persist(manager);
    await handlers.agent_settled({ aborted: false }, ctx);
    assert.equal((await runtime.read({ session_id: 'fixture' })).units.length, 1);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
    if (reason === 'new') {
      await fs.link(session.file, path.join(f.dir, 'new-alias.jsonl'));
      await assert.rejects(runtime.state());
      assert.equal(ctx.stopped, true);
      assert.equal((await readClaim(f.config.attachmentDir, session)).generation, claim.generation);
    }
  }
});

test('missing targets do not bypass canonical parent or observed-file checks', async (t) => {
  const f = await fixture(t),
    handlers = await companionHooks(f);
  const manager = SessionManager.create(f.cwd, f.config.sessionRoots[0]);
  const { file, header } = sessionAt(manager),
    parentAlias = path.join(f.dir, 'root-alias');
  await fs.symlink(f.config.sessionRoots[0], parentAlias);
  const alias = {
    getSessionFile: () => path.join(parentAlias, path.basename(file)),
    getHeader: () => header,
  };
  const start = (ctx) => handlers.session_start({ reason: 'startup' }, ctx);
  await assert.rejects(start(context(alias)), /UNSAFE_NATIVE_SESSION_STORAGE/);
  const ctx = context(manager);
  await start(ctx);
  persist(manager);
  await handlers.agent_settled({ aborted: false }, ctx);
  await fs.unlink(file);
  await assert.rejects(handlers.agent_settled({ aborted: false }, ctx), { code: 'ENOENT' });
  assert.equal(ctx.stopped, true);
});

test('RPC extension storage failure retains ownership without shutting down its external host', async (t) => {
  const f = await fixture(t),
    handlers = await companionHooks(f);
  const ctx = context(SessionManager.open(f.session.file), 'rpc');
  const alias = path.join(f.dir, 'rpc-alias.jsonl');
  await handlers.session_start({}, ctx);
  const claim = await readClaim(f.config.attachmentDir, f.session);
  await fs.link(f.session.file, alias);
  await assert.rejects(
    handlers.agent_settled({ aborted: false }, ctx),
    /SESSION_FILE_ALIAS_NOT_ALLOWED/,
  );
  assert.equal(ctx.stopped, false);
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, claim.generation);
  await fs.unlink(alias);
  await assert.rejects(
    new AttachedRuntime(f.config, f.session, claim).state(),
    /RUNTIME_SESSION_CHANGED/,
  );
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
});
