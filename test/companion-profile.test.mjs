import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { companionProfile, companionIncludes } from '../src/companion-profile.mjs';
import attachExtension from '../src/attach-extension.mjs';
import { SessionManager } from './fixtures/pi.mjs';
import { readClaim, reserveOwner, claimFile } from '../src/attachments.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-companion-profile-');
  const file = path.join(dir, '.config/pi-mcp-bridge/owner.json');
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: dir }],
    defaults: denyAllPermissions(),
    grants: [],
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.mkdir(config.sessionRoots[0]);
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, file, config };
}

test('daily profile uses native HOME/XDG config and existing scope without copying grants', async (t) => {
  const f = await fixture(t);
  const profile = await companionProfile({ HOME: f.dir });
  assert.deepEqual(profile, {
    file: f.file,
    dir: path.join(f.config.stateDir, 'ipc'),
    roots: f.config.sessionRoots,
  });
  assert.deepEqual(
    await companionProfile({ HOME: '/not-used', XDG_CONFIG_HOME: path.join(f.dir, '.config') }),
    profile,
  );
  assert.equal(
    companionIncludes(profile, path.join(f.config.sessionRoots[0], 'fresh.jsonl')),
    true,
  );
  assert.equal(companionIncludes(profile, path.join(f.dir, 'sessions-other', 'x.jsonl')), false);
  assert.equal(companionIncludes(profile, undefined), false);
  assert.equal(companionIncludes(profile, 'relative.jsonl'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(f.file, 'utf8')), f.config);
});

test('missing default profile stays inactive, but broken/explicit profiles fail visibly', async (t) => {
  const f = await fixture(t);
  assert.equal(await companionProfile({ HOME: path.join(f.dir, 'other') }), null);
  await assert.rejects(companionProfile({ PI_MCP_OWNER_CONFIG: f.file + '.missing' }), {
    code: 'ENOENT',
  });
  await fs.chmod(f.file, 0o644);
  await assert.rejects(companionProfile({ HOME: f.dir }), /OWNER_CONFIG_NOT_PRIVATE/);
  await fs.chmod(f.file, 0o600);
  await fs.writeFile(f.file, '{');
  await assert.rejects(companionProfile({ HOME: f.dir }), /INVALID_OWNER_CONFIG/);
});

test('explicit owner profile and directory must agree; directory-only host opt-in remains explicit', async (t) => {
  const f = await fixture(t),
    dir = path.join(f.config.stateDir, 'ipc');
  const profile = await companionProfile({ PI_MCP_OWNER_CONFIG: f.file, PI_MCP_ATTACH_DIR: dir });
  assert.equal(profile.dir, dir);
  assert.deepEqual(profile.roots, f.config.sessionRoots);
  await assert.rejects(
    companionProfile({ PI_MCP_OWNER_CONFIG: f.file, PI_MCP_ATTACH_DIR: f.dir }),
    /HANDOFF_DIRECTORY_MISMATCH/,
  );
  assert.deepEqual(await companionProfile({ PI_MCP_ATTACH_DIR: dir }), {
    dir,
    file: undefined,
    roots: null,
  });
});

test('scoped companion skips excluded bodies and retires only its completed former session', async (t) => {
  const f = await fixture(t);
  const oldFile = process.env.PI_MCP_OWNER_CONFIG,
    oldDir = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_OWNER_CONFIG = f.file;
  delete process.env.PI_MCP_ATTACH_DIR;
  t.after(() => {
    if (oldFile === undefined) delete process.env.PI_MCP_OWNER_CONFIG;
    else process.env.PI_MCP_OWNER_CONFIG = oldFile;
    if (oldDir === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = oldDir;
  });
  const handlers = {};
  await attachExtension({
    on: (n, fn) => (handlers[n] = fn),
    registerShortcut() {},
    registerCommand() {},
  });
  const excluded = {
    mode: 'rpc',
    sessionManager: {
      getSessionFile: () => path.join(f.dir, 'excluded', 'x.jsonl'),
      getHeader() {
        throw Error('excluded header read');
      },
      getEntries() {
        throw Error('excluded body read');
      },
    },
  };
  await handlers.session_start({}, excluded);
  await assert.rejects(fs.stat(path.join(f.config.stateDir, 'ipc')), { code: 'ENOENT' });
  const manager = SessionManager.create(f.dir, f.config.sessionRoots[0]),
    session = { file: manager.getSessionFile(), header: manager.getHeader() };
  const ctx = {
    mode: 'rpc',
    sessionManager: manager,
    isIdle: () => true,
    hasPendingMessages: () => false,
  };
  t.after(() => handlers.session_shutdown({ reason: 'quit' }));
  await handlers.session_start({}, ctx);
  const dir = path.join(f.config.stateDir, 'ipc'),
    before = await readClaim(dir, session);
  assert.equal(before.phase, 'ready');
  await assert.rejects(fs.stat(session.file), { code: 'ENOENT' });
  const otherManager = SessionManager.create(f.dir, f.config.sessionRoots[0]);
  const other = { file: otherManager.getSessionFile(), header: otherManager.getHeader() };
  await fs.writeFile(other.file, JSON.stringify(other.header) + '\n');
  const controller = await reserveOwner(dir, other, 'host');
  const controllerBytes = await fs.readFile(claimFile(dir, other));
  await handlers.session_shutdown({ reason: 'switch' });
  await handlers.session_start({}, excluded);
  assert.equal(await readClaim(dir, session), null);
  assert.deepEqual(await fs.readFile(claimFile(dir, other)), controllerBytes);
  assert.equal((await readClaim(dir, other)).generation, controller.generation);
  assert.equal((await fs.readdir(dir)).filter((p) => p.endsWith('.sock')).length, 0);
});
