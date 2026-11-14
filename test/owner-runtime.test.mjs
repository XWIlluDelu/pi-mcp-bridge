import { until } from './fixtures/until.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcClient } from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest, ownerSocket } from '../src/owner-runtime.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';
import { RpcFailure } from '../src/rpc.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
const exec = promisify(execFile),
  base = path.resolve('.');
async function fixture(t, extraArgs = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-handoff-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
    piArgs: [
      '--offline',
      '--no-context-files',
      '-e',
      path.join(base, 'test/fixtures/faux-extension.mjs'),
      '--provider',
      'bridge-fixture',
      '--model',
      'deterministic',
      ...extraArgs,
    ],
  };
  config.piRuntime.tools = ['read', 'bash', 'edit', 'write'];
  const file = path.join(dir, 'owner.json');
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  let bridge = await new Bridge(config).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  return {
    dir,
    cwd,
    config,
    file,
    session,
    id: session.id,
    get bridge() {
      return bridge;
    },
    restart: async () => {
      await bridge.close();
      bridge = await new Bridge(config).init();
    },
  };
}
test(
  'owner CLI release holds across restart and attachment; only explicit confirmed reset restores cold resume',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      marker = 'GENERIC_RELEASE_RESUME_PROOF';
    assert.equal((await fs.stat(ownerSocket(f.config))).mode & 0o777, 0o600);
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: marker })).status,
      ),
      'Expected native prompt admission',
    );
    const owned = f.bridge.pool.get(f.id);
    const owner = owned.ownerRecord.owner;
    const generation = owned.ownerRecord.generation;
    await until(() => owned.settlementSequence === 1);
    const result = await exec(process.execPath, [
      path.join(base, 'src/owner-runtime.mjs'),
      f.file,
      'release',
      f.id,
    ]);
    assert.equal(JSON.parse(result.stdout).status, 'released');
    assert.equal(await ownerAlive(owner), false);
    let held = await readClaim(f.bridge.pool.attachmentDir, f.session);
    assert.equal(held.phase, 'released');
    assert.equal(held.owner, null);
    assert.equal(held.noColdReacquire, true);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'NEVER_ADMITTED' })).reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    assert.ok(JSON.stringify(await f.bridge.read({ session_id: f.id })).includes(marker));
    await f.restart();
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          text: 'NEVER_ADMITTED',
        })
      ).reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    const local = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
      env: {
        HOME: f.dir,
        PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir,
        PI_MCP_ATTACH_DIR: f.bridge.pool.attachmentDir,
        PI_OFFLINE: '1',
      },
      args: [
        '--session',
        f.session.file,
        '-e',
        path.join(base, 'test/fixtures/faux-extension.mjs'),
        '-e',
        path.join(base, 'src/attach-extension.mjs'),
      ],
      provider: 'bridge-fixture',
      model: 'deterministic',
    });
    t.after(() => local.stop());
    await local.start();
    await local.getState();
    held = await readClaim(f.bridge.pool.attachmentDir, f.session);
    assert.equal(held.kind, 'extension');
    assert.equal(held.noColdReacquire, true);
    assert.notEqual(held.generation, generation);
    for (const interrupt of [false, true])
      await assert.rejects(
        ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt }),
        /EXTERNAL_OWNER_NOT_RELEASABLE/,
      );
    await assert.rejects(
      ownerRequest(f.config, { op: 'reset', session_id: f.id, confirm_local_closed: true }),
      /OWNER_STILL_ALIVE/,
    );
    await local.stop();
    await waitOwnerExit(held.owner);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'NEVER_ADMITTED' })).reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    await assert.rejects(
      ownerRequest(f.config, { op: 'reset', session_id: f.id }),
      /LOCAL_CLOSE_CONFIRMATION_REQUIRED/,
    );
    const reset = await exec(process.execPath, [
      path.join(base, 'src/owner-runtime.mjs'),
      f.file,
      'reset',
      f.id,
      '--confirm-local-closed',
    ]);
    assert.equal(JSON.parse(reset.stdout).status, 'reset');
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'COLD_RESUME_AFTER_RESET' })).status,
      'started',
    );
    assert.equal((await f.bridge.pool.get(f.id).state()).sessionId, f.session.header.id);
  },
);

test('failed normal exit retains the owner claim without reporting release success', async (t) => {
  const f = await fixture(t),
    owned = await f.bridge.pool.resolve(f.session),
    exit = owned.gracefulExit;
  owned.gracefulExit = async () => {
    throw new RpcFailure('RUNTIME_EXIT_ABNORMAL');
  };
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RUNTIME_EXIT_ABNORMAL/,
  );
  const held = await readClaim(f.bridge.pool.attachmentDir, f.session);
  assert.equal(held.noColdReacquire, true);
  assert.equal(await ownerAlive(held.owner), true);
  owned.gracefulExit = exit;
  assert.equal(
    (await ownerRequest(f.config, { op: 'release', session_id: f.id })).status,
    'released',
  );
});

test('release of saved session and reset serialize with sends; pending startup is not aborted', async (t) => {
  const f = await fixture(t);
  f.bridge.pool.starting.set(f.id, { promise: new Promise(() => {}) });
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RUNTIME_IDLE_UNCONFIRMED/,
  );
  f.bridge.pool.starting.delete(f.id);
  const release = ownerRequest(f.config, { op: 'release', session_id: f.id });
  await release;
  const sends = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      f.bridge.send({ session_id: f.id, text: 'NEVER_ADMITTED' }),
    ),
  );
  assert.ok(sends.every((s) => s.reason === 'COLD_REACQUIRE_BLOCKED'));
  assert.equal(f.bridge.pool.instances.size, 0);
});

test(
  'owned RPC vetoes cross-file resume/new/fork before open while keeping its claim and read-only route',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, [
      '-e',
      path.join(base, 'test/fixtures/native-session-boundary.mjs'),
    ]);
    const marker = path.join(f.dir, 'boundary');
    const other = await savedSession(f.bridge),
      b = await f.bridge.session(other.session_id);
    const bytes = await fs.readFile(b.file);
    await fs.appendFile(
      f.session.file,
      JSON.stringify({
        type: 'message',
        id: 'fork-source',
        parentId: null,
        message: { role: 'user', content: 'BOUNDARY_SOURCE', timestamp: 0 },
      }) + '\n',
    );
    const runtime = await f.bridge.pool.resolve(f.session),
      generation = runtime.ownerRecord.generation;
    // A manually retained writer makes the native lifecycle itself observable.
    for (const [command, suffix] of [
      ['/boundary-switch ' + b.file, '.switch'],
      ['/boundary-new', '.new'],
      ['/boundary-fork', '.fork'],
    ]) {
      assert.equal(
        (await runtime.command({ type: 'prompt', message: command })).disposition,
        'handled',
      );
      await until(() =>
        fs.stat(marker + suffix).then(
          () => true,
          () => false,
        ),
      );
      assert.equal(JSON.parse(await fs.readFile(marker + suffix, 'utf8')).cancelled, true);
      assert.equal((await runtime.state()).sessionId, f.session.header.id);
      assert.equal(runtime.child.exitCode, null);
      const claim = await readClaim(f.bridge.pool.attachmentDir, f.session);
      assert.equal(claim.generation, generation);
      assert.equal(await ownerAlive(claim.owner), true);
      assert.equal(await readClaim(f.bridge.pool.attachmentDir, b), null);
    }
    await assert.rejects(fs.stat(marker + '.with-session'), { code: 'ENOENT' });
    await assert.rejects(fs.stat(marker + '.setup'), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(b.file), bytes);
    f.config.grants = [{ session_id: f.id, list: true, read: true }];
    await f.bridge.read({ session_id: f.id });
    await f.bridge.list({ session_id: f.id });
    assert.equal(runtime.child.exitCode, null);
  },
);
