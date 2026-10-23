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
async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('FIXTURE_TIMEOUT');
}
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
    await until(() => owned.settlement.sequence === 1);
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
    const attached = await f.bridge.pool.forRead(f.session);
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'ATTACHED_HANDOFF_PROOF',
        })
      ).dispatch,
      undefined,
    );
    await until(async () => {
      const { activity } = await attached.state();
      return activity?.idle === true && activity.pending_messages === false;
    });
    const entries = (await local.getEntries()).entries;
    for (const text of [marker, 'ATTACHED_HANDOFF_PROOF'])
      assert.equal(
        entries.filter(
          (e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes(text),
        ).length,
        1,
      );
    assert.equal(
      entries.some((e) => JSON.stringify(e).includes('NEVER_ADMITTED')),
      false,
    );
    assert.equal((await local.getState()).sessionId, f.session.header.id);
    assert.equal((await local.bash('pwd')).output.trim(), f.cwd);
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
    assert.ok(!(await fs.readdir(f.bridge.pool.attachmentDir)).includes('registry.lock'));
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (
          await f.bridge.send({
            session_id: f.id,

            text: 'COLD_RESUME_AFTER_RESET',
          })
        ).status,
      ),
      'Expected native prompt admission',
    );
    assert.equal((await f.bridge.pool.get(f.id).state()).sessionId, f.session.header.id);
  },
);
test(
  'real RPC reload replaces the observer socket and keeps owned release usable',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      extension = path.join(f.dir, 'reload.mjs');
    await fs.writeFile(
      extension,
      "export default pi=>pi.registerCommand('fixture-reload',{handler:async(_args,ctx)=>{await ctx.reload();}});",
    );
    f.config.piArgs.push('-e', extension);
    const owned = await f.bridge.pool.resolve(f.session),
      record = owned.ownerRecord;
    await owned.assertReleasable();
    for (let i = 0; i < 2; i++) {
      const ack = await owned.command({ type: 'prompt', message: '/fixture-reload' });
      assert.equal(ack.disposition, 'handled');
      assert.equal(
        (await readClaim(f.bridge.pool.attachmentDir, f.session)).generation,
        record.generation,
      );
      assert.equal(await ownerAlive(record.owner), true);
      await owned.assertReleasable();
    }
    assert.equal(
      (await ownerRequest(f.config, { op: 'release', session_id: f.id })).status,
      'released',
    );
    assert.equal(await ownerAlive(record.owner), false);
    await assert.rejects(fs.stat(record.socket), { code: 'ENOENT' });
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
test('release preserves state errors and never stops a mismatched child', async (t) => {
  const f = await fixture(t),
    owned = await f.bridge.pool.resolve(f.session),
    owner = owned.ownerRecord.owner;
  const dispatch = owned.dispatch;
  owned.dispatch = async () => {
    throw new RpcFailure('ACK_TIMEOUT');
  };
  await assert.rejects(ownerRequest(f.config, { op: 'release', session_id: f.id }), /ACK_TIMEOUT/);
  assert.equal(await ownerAlive(owner), true);
  assert.notEqual((await readClaim(f.bridge.pool.attachmentDir, f.session)).noColdReacquire, true);
  owned.dispatch = async () => ({ sessionFile: '/synthetic/other.jsonl', sessionId: 'other' });
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RUNTIME_SESSION_CHANGED/,
  );
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt: true }),
    /RUNTIME_SESSION_CHANGED/,
  );
  assert.equal(await ownerAlive(owner), true);
  owned.dispatch = dispatch;
});
test('release refuses busy, unknown state and admission ambiguity without signals', async (t) => {
  const f = await fixture(t),
    owned = await f.bridge.pool.resolve(f.session),
    dispatch = owned.dispatch;
  for (const [extra, error] of [
    [{ isStreaming: true }, 'RUNTIME_BUSY'],
    [{ isCompacting: true }, 'RUNTIME_BUSY'],
    [{ pendingMessageCount: 1 }, 'RUNTIME_BUSY'],
    [{ isStreaming: undefined }, 'RUNTIME_IDLE_UNCONFIRMED'],
  ]) {
    owned.dispatch = async () => ({
      sessionFile: f.session.file,
      sessionId: f.session.header.id,
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
      ...extra,
    });
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id }),
      new RegExp(error),
    );
    assert.equal(await ownerAlive(owned.ownerRecord.owner), true);
  }
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt: 'yes' }),
    /INVALID_OWNER_COMMAND/,
  );
  owned.promptAdmission = { id: 'ambiguous', generation: owned.generation };
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /PROMPT_ADMISSION_PENDING/,
  );
  owned.promptAdmission = null;
  owned.dispatch = dispatch;
});
for (const overlap of [false, true])
  test(
    overlap
      ? 'observed overlapping extension inputs remain unconfirmed after unrelated settlement'
      : 'independent extension startup reports busy before agent_start',
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(t),
        gate = path.join(f.dir, 'continue'),
        started = path.join(f.dir, 'preparing'),
        extension = path.join(f.dir, 'prepare.mjs');
      const messages = overlap ? ['OVERLAP_A', 'ASYNC_PREFLIGHT'] : ['ASYNC_PREFLIGHT'];
      await fs.writeFile(
        extension,
        `import fs from 'node:fs/promises';export default pi=>{
    pi.registerCommand('autonomous-preflight',{handler:()=>{for(const text of ${JSON.stringify(messages)})pi.sendUserMessage(text,{deliverAs:'followUp'});}});
    pi.registerCommand('preflight-reload',{handler:async(_args,ctx)=>{await ctx.reload();}});
    pi.on(${JSON.stringify(overlap ? 'input' : 'before_agent_start')},async event=>{if((event.text??event.prompt)==='ASYNC_PREFLIGHT'){await fs.writeFile(${JSON.stringify(started)},'started');while(!await fs.stat(${JSON.stringify(gate)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));}return {action:'continue'};});
  };`,
      );
      f.config.piArgs.push('-e', extension);
      assert.equal(
        (
          await f.bridge.send({
            session_id: f.id,

            text: '/autonomous-preflight',
          })
        ).status,
        'handled',
      );
      await until(() =>
        fs.stat(started).then(
          () => true,
          () => false,
        ),
      );
      const owned = f.bridge.pool.get(f.id);
      if (overlap) await until(() => owned.settlement.sequence === 1);
      const state = await owned.state();
      assert.equal(state.isStreaming, !overlap); // input hooks precede busy; before_agent_start no longer does.
      assert.equal(state.pendingMessageCount, 0);
      assert.equal(owned.promptAdmission, null);
      const owner = owned.ownerRecord.owner;
      const release = await ownerRequest(f.config, { op: 'release', session_id: f.id }).then(
        (value) => ({ status: value.status }),
        (error) => ({ reason: error.message }),
      );
      assert.deepEqual(
        { release, ownerAlive: await ownerAlive(owner) },
        {
          release: { reason: overlap ? 'RUNTIME_IDLE_UNCONFIRMED' : 'RUNTIME_BUSY' },
          ownerAlive: true,
        },
      );
      assert.notEqual(
        (await readClaim(f.bridge.pool.attachmentDir, f.session)).noColdReacquire,
        true,
      );
      await fs.writeFile(gate, 'continue');
      await until(() => owned.settlement.sequence === (overlap ? 2 : 1));
      if (overlap) {
        await assert.rejects(
          ownerRequest(f.config, { op: 'release', session_id: f.id }),
          /RUNTIME_IDLE_UNCONFIRMED/,
        );
        assert.equal(await ownerAlive(owner), true);
        assert.equal(
          (await owned.command({ type: 'prompt', message: '/preflight-reload' })).disposition,
          'handled',
        );
        await assert.rejects(
          ownerRequest(f.config, { op: 'release', session_id: f.id }),
          /RUNTIME_IDLE_UNCONFIRMED/,
        );
        assert.equal(await ownerAlive(owner), true);
      }
      // Settlement has no correlation ID for independent extension preflight.
      // A deliberate owner interruption gives this generation a recovery exit.
      await assert.rejects(
        ownerRequest(f.config, { op: 'release', session_id: f.id }),
        /RUNTIME_IDLE_UNCONFIRMED/,
      );
      const released = await exec(process.execPath, [
        path.join(base, 'src/owner-runtime.mjs'),
        f.file,
        'release',
        f.id,
        '--interrupt',
      ]);
      assert.equal(JSON.parse(released.stdout).status, 'released');
      assert.equal(await ownerAlive(owner), false);
      assert.notEqual(owned.child.signalCode, 'SIGKILL');
      await ownerRequest(f.config, { op: 'reset', session_id: f.id, confirm_local_closed: true });
      assert.ok(
        ['started', 'queued', 'handled'].includes(
          (
            await f.bridge.send({
              session_id: f.id,

              text: 'AFTER_MAINTENANCE',
            })
          ).status,
        ),
        'Expected native prompt admission',
      );
      const fresh = f.bridge.pool.get(f.id);
      assert.notEqual(fresh.generation, owned.generation);
      await until(() => fresh.exited && !f.bridge.autoReleases.size);
      assert.equal(fresh.child.exitCode, 0);
      assert.equal(fresh.child.signalCode, null);
      const projected = await f.bridge.read({ session_id: f.id });
      assert.ok(JSON.stringify(projected).includes('AFTER_MAINTENANCE'));
    },
  );
test('release of saved session and reset serialize with sends; pending startup is not aborted', async (t) => {
  const f = await fixture(t);
  f.bridge.pool.starting.set(f.id, new Promise(() => {}));
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
