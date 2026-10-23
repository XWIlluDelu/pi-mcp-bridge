import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { discover, loadSession } from '../src/data.mjs';
import { reserveOwner, releaseOwner, updateOwner, processIdentity } from '../src/attachments.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readClaim, AttachedRuntime } from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';

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

test('an obsolete exact process identity does not fence a replacement native ID forever', async (t) => {
  const f = await fixture(t),
    identity = await processIdentity();
  const stale = await reserveOwner(f.config.attachmentDir, f.session, 'rpc', {
    ...identity,
    start: 'obsolete-start',
  });
  const header = { ...f.session.header, id: 'replacement-public-id' };
  await fs.writeFile(f.session.file, JSON.stringify(header) + '\n');
  const changed = (await discover(f.config))[0],
    replacement = await reserveOwner(f.config.attachmentDir, changed, 'rpc');
  assert.equal(replacement.sessionId, header.id);
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, stale.generation);
  await releaseOwner(f.config.attachmentDir, changed, replacement);
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

test('initial attachment rejects a persisted file belonging to a different native manager', async (t) => {
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
  const first = SessionManager.create(f.dir, f.config.sessionRoots[0]),
    file = first.getSessionFile(),
    second = SessionManager.open(file);
  assert.notEqual(first.getSessionId(), second.getSessionId());
  first.appendMessage({ role: 'user', content: 'first owner persisted', timestamp: Date.now() });
  try {
    await assert.rejects(
      handlers.session_start(
        {},
        {
          mode: 'tui',
          sessionManager: second,
          isIdle: () => true,
          shutdown: () => {
            stopped = true;
          },
        },
      ),
      /RUNTIME_SESSION_CHANGED/,
    );
    assert.equal(stopped, true);
    assert.equal(
      await readClaim(f.config.attachmentDir, { file, header: second.getHeader() }),
      null,
    );
  } finally {
    await handlers.session_shutdown({});
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

test('large persisted histories do not prevent TUI registration or first-persistence identity checks', async (t) => {
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
  try {
    for (const timing of ['before-registration', 'after-registration']) {
      if (timing === 'after-registration') await handlers.session_shutdown({ reason: 'new' });
      const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
        file = manager.getSessionFile();
      const persist = async () => {
        manager.appendMessage({
          role: 'user',
          content: 'large saved public fixture',
          timestamp: Date.now(),
        });
        // Keep the live fixture small: disk size must not enter ownership validation.
        await fs.appendFile(
          file,
          JSON.stringify({
            type: 'custom',
            id: 'large-fixture',
            parentId: null,
            data: 'x'.repeat(32 * 1024 * 1024),
          }) + '\n',
        );
      };
      if (timing === 'before-registration') await persist();
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
      if (timing === 'after-registration') {
        await persist();
        await handlers.agent_settled({ aborted: false });
      }
      const session = { file, header: manager.getHeader() },
        claim = await readClaim(f.config.attachmentDir, session);
      assert.equal(claim.phase, 'ready');
      assert.equal(stopped, false);
      const runtime = new AttachedRuntime(f.config, session, claim);
      assert.equal((await runtime.state()).sessionId, session.header.id);
      assert.equal((await runtime.read({ session_id: 'fixture' })).units.length, 1);
    }
  } finally {
    await handlers.session_shutdown({});
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

test('persisted paths retain protection against a different live native owner claim', async (t) => {
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
    file = first.getSessionFile(),
    second = SessionManager.open(file);
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
    await assert.rejects(
      b.session_start(
        {},
        {
          mode: 'tui',
          sessionManager: second,
          isIdle: () => true,
          shutdown: () => {
            stopped = true;
          },
        },
      ),
      /LIVE_OWNER_UNREACHABLE/,
    );
    assert.equal(stopped, true);
    assert.equal(await readClaim(f.config.attachmentDir, sessionB), null);
    assert.equal((await readClaim(f.config.attachmentDir, sessionA)).generation, claim.generation);
  } finally {
    await a.session_shutdown({});
    await b.session_shutdown({});
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-alias-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    piExecutable: nativePiCli,
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
    attachmentDir: path.join(dir, 'ipc'),
  };
  const bridge = await new Bridge(config).init();
  const created = await savedSession(bridge),
    session = await bridge.session(created.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, config, bridge, created, session };
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
test('public identity remains path/header based across restart and same-header atomic replacement', async (t) => {
  const f = await fixture(t),
    bytes = await fs.readFile(f.session.file),
    originalInode = (await fs.stat(f.session.file)).ino;
  const claim = await reserveOwner(f.config.attachmentDir, f.session, 'rpc');
  const replacement = f.session.file + '.replacement';
  await fs.writeFile(replacement, bytes);
  await fs.rename(replacement, f.session.file);
  assert.notEqual((await fs.stat(f.session.file)).ino, originalInode);
  assert.equal((await f.bridge.sessions())[0].id, f.session.id);
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
  await releaseOwner(f.config.attachmentDir, f.session, claim);
  await f.bridge.close();
  const restarted = await new Bridge(f.config).init();
  try {
    assert.equal((await restarted.sessions())[0].id, f.session.id);
  } finally {
    await restarted.close();
  }
  const data = JSON.parse(bytes.toString().trim());
  data.id = '40242f4e-1d23-4eba-bd14-367658ad8e44';
  await fs.writeFile(f.session.file, JSON.stringify(data) + '\n');
  assert.notEqual((await discover(f.config))[0].id, f.session.id);
});
test('TUI claim rejects hardlink and symlink aliases before publishing a record', async (t) => {
  const f = await fixture(t),
    original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  t.after(() => {
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  });
  const hardlink = path.join(f.dir, 'hard.jsonl'),
    symlink = path.join(f.dir, 'sym.jsonl');
  await fs.link(f.session.file, hardlink);
  await fs.symlink(f.session.file, symlink);
  for (const file of [f.session.file, hardlink, symlink]) {
    const handlers = {};
    let shutdown = false;
    await attachExtension({
      getThinkingLevel: () => 'off',
      on: (name, fn) => {
        handlers[name] = fn;
      },
    });
    const ctx = {
      mode: 'tui',
      sessionManager: { getSessionFile: () => file, getHeader: () => f.session.header },
      shutdown: () => {
        shutdown = true;
      },
    };
    await assert.rejects(handlers.session_start({}, ctx), /SESSION_FILE_ALIAS_NOT_ALLOWED/);
    assert.equal(shutdown, true);
  }
  assert.deepEqual(
    (await fs.readdir(f.config.attachmentDir)).filter((x) => x.endsWith('.owner.json')),
    [],
  );
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
  try {
    for (const reason of ['startup', 'new']) {
      if (reason === 'new') await handlers.session_shutdown({ reason: 'new' });
      const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
        file = manager.getSessionFile();
      await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      await handlers.session_start({ reason }, context(manager));
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
      await handlers.agent_settled({ aborted: false });
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
    await handlers.agent_settled({ aborted: false });
    await fs.unlink(file);
    await assert.rejects(handlers.agent_settled({ aborted: false }), { code: 'ENOENT' });
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
      handlers.agent_settled({ aborted: false }),
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

test('first persistence between missing lstat and memory snapshot is revalidated before shutdown', async (t) => {
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
  const realLstat = fs.lstat;
  try {
    for (const mutation of ['valid', 'valid-name-event', 'hardlink', 'wrong-header', 'removed']) {
      if (mutation !== 'valid') await handlers.session_shutdown({ reason: 'new' });
      stopped = false;
      const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
        file = manager.getSessionFile();
      await handlers.session_start(
        { reason: 'new' },
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
      const session = { file, header: manager.getHeader() },
        claim = await readClaim(f.config.attachmentDir, session),
        runtime = new AttachedRuntime(f.config, session, claim);
      let raced = false;
      t.mock.method(fs, 'lstat', async function (target, ...args) {
        try {
          return await realLstat.call(fs, target, ...args);
        } catch (error) {
          if (target === file && error.code === 'ENOENT' && !raced) {
            raced = true;
            manager.appendMessage({
              role: 'user',
              content: 'first persisted fixture',
              timestamp: Date.now(),
            });
            if (mutation === 'hardlink')
              await fs.link(file, path.join(f.dir, 'racing-alias.jsonl'));
            if (mutation === 'wrong-header') {
              const lines = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
              lines[0].id = 'different-native-id';
              await fs.writeFile(file, lines.map(JSON.stringify).join('\n') + '\n');
            }
            if (mutation === 'removed') await fs.unlink(file);
          }
          throw error; // Return the old missing-file observation after persistence.
        }
      });
      try {
        if (mutation.startsWith('valid')) {
          if (mutation === 'valid-name-event')
            await handlers.session_info_changed({ name: 'public fixture' });
          assert.equal((await runtime.state()).sessionId, session.header.id);
          assert.equal(stopped, false);
          assert.equal((await runtime.read({ session_id: 'fixture' })).units.length, 1);
        } else {
          await assert.rejects(runtime.state());
          assert.equal(stopped, true);
        }
        assert.equal(raced, true);
        assert.equal(
          (await readClaim(f.config.attachmentDir, session)).generation,
          claim.generation,
        );
      } finally {
        t.mock.restoreAll();
      }
    }
  } finally {
    t.mock.restoreAll();
    await handlers.session_shutdown({ reason: 'quit' });
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});
