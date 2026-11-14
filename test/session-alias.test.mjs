import { nativeOwner } from './fixtures/native-owner.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';

import { discover, loadSession } from '../src/data.mjs';
import { reserveOwner, releaseOwner, updateOwner } from '../src/attachments.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { SessionManager } from './fixtures/pi.mjs';
import { readClaim, AttachedRuntime } from '../src/attachments.mjs';
import attachExtension from './fixtures/companion.mjs';

test('RPC reservation rejects a different live native ID at the same path before spawning', async (t) => {
  for (const kind of ['tui', 'rpc'])
    await t.test(kind, async (t) => {
      const f = await fixture(t),
        claim = await reserveOwner(f.config.attachmentDir, f.session, kind);
      const header = { ...f.session.header, id: 'replacement-public-id' };
      await fs.writeFile(f.session.file, JSON.stringify(header) + '\n');
      const changed = (await discover(f.config))[0];
      assert.notEqual(changed.id, f.session.id);
      for (const phase of ['starting', 'ready', 'transitioning']) {
        await updateOwner(f.config.attachmentDir, f.session, claim, { phase });
        const before = await readClaim(f.config.attachmentDir, f.session);
        await assert.rejects(
          reserveOwner(f.config.attachmentDir, changed, 'rpc'),
          /LIVE_OWNER_UNREACHABLE/,
        );
        const runtime = new PiRpc(f.config, changed);
        t.after(() => runtime.stop());
        await assert.rejects(runtime.start(), /LIVE_OWNER_UNREACHABLE/);
        assert.equal(runtime.child, undefined);
        assert.deepEqual(await readClaim(f.config.attachmentDir, f.session), before);
        assert.equal(await readClaim(f.config.attachmentDir, changed), null);
      }
      await releaseOwner(f.config.attachmentDir, f.session, claim);
      const replacement = await reserveOwner(f.config.attachmentDir, changed, 'rpc');
      await releaseOwner(f.config.attachmentDir, changed, replacement);
    });
});

test('initial attachment rechecks first persistence after a missing-file snapshot', async (t) => {
  const f = await fixture(t),
    original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  let stopped = false;
  await attachExtension({
    getThinkingLevel: () => 'off',
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
    file = manager.getSessionFile(),
    realLstat = fs.lstat;
  let raced = false;
  t.mock.method(fs, 'lstat', async function (target, ...args) {
    try {
      return await realLstat.call(fs, target, ...args);
    } catch (error) {
      if (target === file && error.code === 'ENOENT' && !raced) {
        raced = true;
        manager.appendMessage({
          role: 'user',
          content: 'initial persistence fixture',
          timestamp: Date.now(),
        });
      }
      throw error;
    }
  });
  try {
    await handlers.session_start(
      {},
      {
        mode: 'tui',
        sessionManager: manager,
        isIdle: () => true,
        hasPendingMessages: () => false,
        shutdown: () => {
          stopped = true;
        },
      },
    );
    assert.equal(raced, true);
    assert.equal(stopped, false);
    const session = { file, header: manager.getHeader() },
      claim = await readClaim(f.config.attachmentDir, session);
    assert.equal(claim.phase, 'ready');
    assert.equal(
      (await new AttachedRuntime(f.config, session, claim).state()).sessionId,
      session.header.id,
    );
  } finally {
    t.mock.restoreAll();
    await handlers.session_shutdown({});
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

for (const persisted of [false, true])
  test(`independent managers at the same path stay distinct ${persisted ? 'after' : 'before'} first persistence`, async (t) => {
    const f = await fixture(t),
      original = process.env.PI_MCP_ATTACH_DIR;
    process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
    const a = {},
      b = {};
    await attachExtension({
      getThinkingLevel: () => 'off',
      on: (name, fn) => {
        a[name] = fn;
      },
    });
    await attachExtension({
      getThinkingLevel: () => 'off',
      on: (name, fn) => {
        b[name] = fn;
      },
    });
    const first = SessionManager.create(f.dir, f.config.sessionRoots[0]),
      file = first.getSessionFile();
    if (persisted)
      first.appendMessage({
        role: 'user',
        content: 'first manager persisted',
        timestamp: Date.now(),
      });
    const second = SessionManager.open(file);
    assert.equal(first.getSessionId() === second.getSessionId(), persisted);
    const sessionA = { file, header: first.getHeader() },
      sessionB = { file, header: second.getHeader() };
    let stopped = false;
    try {
      await a.session_start(
        {},
        { mode: 'tui', sessionManager: first, isIdle: () => true, shutdown: () => {} },
      );
      const claim = await readClaim(f.config.attachmentDir, sessionA);
      second.appendMessage({
        role: 'user',
        content: 'second manager persisted first',
        timestamp: Date.now(),
      });
      const ctxB = {
        mode: 'tui',
        sessionManager: second,
        isIdle: () => true,
        shutdown: () => {
          stopped = true;
        },
      };
      for (const reason of ['startup', 'reload'])
        await assert.rejects(b.session_start({ reason }, ctxB), /LIVE_OWNER_UNREACHABLE/);
      assert.equal(stopped, true);
      if (!persisted) assert.equal(await readClaim(f.config.attachmentDir, sessionB), null);
      assert.equal(
        (await readClaim(f.config.attachmentDir, sessionA)).generation,
        claim.generation,
      );
      if (persisted) {
        await a.session_shutdown({ reason: 'reload' });
        await assert.rejects(b.session_start({ reason: 'reload' }, ctxB), /LIVE_OWNER_UNREACHABLE/);
        await a.session_start(
          { reason: 'reload' },
          {
            mode: 'tui',
            sessionManager: first,
            isIdle: () => true,
            shutdown: () => {},
          },
        );
        assert.notEqual(
          (await readClaim(f.config.attachmentDir, sessionA)).generation,
          claim.generation,
        );
      }
      const third = SessionManager.create(f.dir, f.config.sessionRoots[0]);
      const ctxC = { ...ctxB, sessionManager: third };
      const preserved = await readClaim(f.config.attachmentDir, sessionA);
      await b.session_start({ reason: 'startup' }, ctxC);
      assert.deepEqual(await readClaim(f.config.attachmentDir, sessionA), preserved);
      assert.deepEqual(
        await b.session_before_switch({ reason: 'resume', targetSessionFile: file }, ctxC),
        { cancel: true },
      );
    } finally {
      await a.session_shutdown({});
      await b.session_shutdown({});
      if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
      else process.env.PI_MCP_ATTACH_DIR = original;
    }
  });

async function fixture(t) {
  const f = await nativeOwner(t, { prefix: 'alias' });
  return { ...f, created: { session_id: f.id } };
}
test('hardlink aliases are hidden and stale discovered targets cannot claim or spawn', async (t) => {
  const f = await fixture(t),
    alias = path.join(f.config.sessionRoots[0], 'alias.jsonl');
  await fs.link(f.session.file, alias);
  assert.equal((await fs.stat(alias)).ino, (await fs.stat(f.session.file)).ino);
  assert.deepEqual(await discover(f.config), []);
  for (const file of [f.session.file, alias]) {
    await assert.rejects(loadSession(file), /SESSION_FILE_ALIAS_NOT_ALLOWED/);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, { ...f.session, file }, 'rpc'),
      /SESSION_FILE_ALIAS_NOT_ALLOWED/,
    );
    const rpc = new PiRpc(f.config, { ...f.session, file });
    await assert.rejects(rpc.start(), /SESSION_FILE_ALIAS_NOT_ALLOWED/);
    assert.equal(rpc.child, undefined);
  }
  assert.deepEqual(
    (await fs.readdir(f.config.attachmentDir)).filter((x) => x.endsWith('.owner.json')),
    [],
  );
  await fs.unlink(alias);
  assert.equal((await f.bridge.sessions())[0].id, f.session.id);
});

test('native unflushed startup and /new reserve their paths and validate after persistence', async (t) => {
  const f = await fixture(t),
    original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  let stopped = false;
  await attachExtension({
    getThinkingLevel: () => 'off',
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const context = (manager) => ({
    mode: 'tui',
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
    shutdown: () => {
      stopped = true;
    },
  });
  let previousSessionFile;
  try {
    for (const reason of ['startup', 'new']) {
      if (reason === 'new') await handlers.session_shutdown({ reason: 'new' });
      const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
        file = manager.getSessionFile();
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      await handlers.session_start({ reason, previousSessionFile }, context(manager));
      previousSessionFile = file;
      assert.equal(stopped, false);
      const session = { file, header: manager.getHeader() },
        claim = await readClaim(f.config.attachmentDir, session);
      assert.equal(claim.phase, 'ready');
      const runtime = new AttachedRuntime(f.config, session, claim);
      assert.equal((await runtime.state()).sessionId, session.header.id);
      manager.appendMessage({
        role: 'user',
        content: 'native persistence fixture',
        timestamp: Date.now(),
      });
      await handlers.agent_settled({ aborted: false }, context(manager));
      assert.equal((await runtime.read({ session_id: 'fixture' })).units.length, 1);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      if (reason === 'new') {
        const alias = path.join(f.dir, 'new-alias.jsonl');
        await fs.link(file, alias);
        await assert.rejects(runtime.state());
        assert.equal(stopped, true);
        assert.equal(
          (await readClaim(f.config.attachmentDir, session)).generation,
          claim.generation,
        );
      }
    }
  } finally {
    await handlers.session_shutdown({ reason: 'quit' });
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});
test('missing targets do not bypass canonical parent or observed-file checks', async (t) => {
  const f = await fixture(t),
    original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  let stopped = false;
  await attachExtension({
    getThinkingLevel: () => 'off',
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
    file = manager.getSessionFile();
  const parentAlias = path.join(f.dir, 'root-alias');
  await fs.symlink(f.config.sessionRoots[0], parentAlias);
  try {
    await assert.rejects(
      handlers.session_start(
        { reason: 'startup' },
        {
          mode: 'tui',
          sessionManager: {
            getSessionFile: () => path.join(parentAlias, path.basename(file)),
            getHeader: () => manager.getHeader(),
          },
          shutdown: () => {},
        },
      ),
      /SESSION_FILE_ALIAS_NOT_ALLOWED/,
    );
    const ctx = {
      mode: 'tui',
      sessionManager: manager,
      isIdle: () => true,
      hasPendingMessages: () => false,
      shutdown: () => {
        stopped = true;
      },
    };
    await handlers.session_start({ reason: 'startup' }, ctx);
    manager.appendMessage({
      role: 'user',
      content: 'persist then remove fixture',
      timestamp: Date.now(),
    });
    await handlers.agent_settled({ aborted: false }, ctx);
    await fs.unlink(file);
    await assert.rejects(handlers.agent_settled({ aborted: false }, ctx), { code: 'ENOENT' });
    assert.equal(stopped, true);
  } finally {
    await handlers.session_shutdown({ reason: 'quit' });
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

test('RPC extension storage failure retains ownership without shutting down its external host', async (t) => {
  const f = await fixture(t),
    original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  let shutdowns = 0;
  await attachExtension({
    getThinkingLevel: () => 'off',
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const manager = SessionManager.open(f.session.file),
    ctx = {
      mode: 'rpc',
      sessionManager: manager,
      isIdle: () => true,
      hasPendingMessages: () => false,
      shutdown: () => {
        shutdowns++;
      },
    };
  const alias = path.join(f.dir, 'rpc-alias.jsonl');
  try {
    await handlers.session_start({}, ctx);
    const claim = await readClaim(f.config.attachmentDir, f.session);
    await fs.link(f.session.file, alias);
    await assert.rejects(
      handlers.agent_settled({ aborted: false }, ctx),
      /SESSION_FILE_ALIAS_NOT_ALLOWED/,
    );
    assert.equal(shutdowns, 0);
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
  } finally {
    await handlers.session_shutdown({});
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});
