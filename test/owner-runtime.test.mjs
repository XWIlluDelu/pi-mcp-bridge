import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest, ownerSocket } from '../src/owner-runtime.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';
import { RpcFailure } from '../src/rpc.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
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
    principal: 'handoff-test',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: cwd }],
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
  const made = await savedSession(bridge, { folder_id: 'project', request_id: 'seed' }),
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
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'owned', text: marker })).status,
      'accepted',
    );
    const owned = f.bridge.pool.get(f.id);
    await until(() => owned.settlement.sequence === 1);
    const old = await readClaim(f.bridge.pool.attachmentDir, f.session);
    const result = await exec(process.execPath, [
      path.join(base, 'src/owner-runtime.mjs'),
      f.file,
      'release',
      f.id,
    ]);
    assert.equal(JSON.parse(result.stdout).status, 'released');
    assert.equal(await ownerAlive(old.owner), false);
    let held = await readClaim(f.bridge.pool.attachmentDir, f.session);
    assert.equal(held.phase, 'released');
    assert.equal(held.owner, null);
    assert.equal(held.noColdReacquire, true);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'blocked', text: 'NEVER_ADMITTED' }))
        .reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    assert.ok(JSON.stringify(await f.bridge.read({ session_id: f.id })).includes(marker));
    await f.restart();
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          request_id: 'blocked-after-restart',
          text: 'NEVER_ADMITTED',
        })
      ).reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    const local = new RpcClient({
      cliPath: path.join(base, 'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),
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
    assert.notEqual(held.generation, old.generation);
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id }),
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
          request_id: 'attached',
          text: 'ATTACHED_HANDOFF_PROOF',
        })
      ).dispatch,
      'submitted',
    );
    await until(async () => (await attached.state()).activity?.settlement?.sequence > 0);
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
      (await f.bridge.send({ session_id: f.id, request_id: 'still-held', text: 'NEVER_ADMITTED' }))
        .reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    await assert.rejects(
      ownerRequest(f.config, { op: 'reset', session_id: f.id }),
      /LOCAL_CLOSE_CONFIRMATION_REQUIRED/,
    );
    const lock = path.join(f.bridge.pool.attachmentDir, 'registry.lock');
    await fs.writeFile(lock, JSON.stringify(held.owner), { mode: 0o600 }); // Interrupted registry cleanup from the now-dead native owner.
    const reset = await exec(process.execPath, [
      path.join(base, 'src/owner-runtime.mjs'),
      f.file,
      'reset',
      f.id,
      '--confirm-local-closed',
    ]);
    assert.equal(JSON.parse(reset.stdout).status, 'reset');
    await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          request_id: 'resumed',
          text: 'COLD_RESUME_AFTER_RESET',
        })
      ).status,
      'accepted',
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
test('stop failure retains no-cold marker without claiming release success', async (t) => {
  const f = await fixture(t),
    owned = await f.bridge.pool.resolve(f.session),
    stop = owned.stop;
  owned.stop = async () => {
    throw new RpcFailure('RPC_STOP_TIMEOUT');
  };
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RPC_STOP_TIMEOUT/,
  );
  const held = await readClaim(f.bridge.pool.attachmentDir, f.session);
  assert.equal(held.noColdReacquire, true);
  assert.equal(await ownerAlive(held.owner), true);
  owned.stop = stop;
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
      : 'independent extension preflight stays unconfirmed even when public isIdle reports true',
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
    pi.registerCommand('autonomous-preflight',{handler:()=>{for(const text of ${JSON.stringify(messages)})pi.sendUserMessage(text);}});
    pi.registerCommand('preflight-reload',{handler:async(_args,ctx)=>{await ctx.reload();}});
    pi.on('before_agent_start',async event=>{if(event.prompt!=='ASYNC_PREFLIGHT')return;await fs.writeFile(${JSON.stringify(started)},'started');while(!await fs.stat(${JSON.stringify(gate)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));});
  };`,
      );
      f.config.piArgs.push('-e', extension);
      assert.equal(
        (
          await f.bridge.send({
            session_id: f.id,
            request_id: 'prepare',
            text: '/autonomous-preflight',
          })
        ).disposition,
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
      assert.equal(state.isStreaming, false);
      assert.equal(state.pendingMessageCount, 0);
      assert.equal(owned.promptAdmission, null);
      const owner = owned.ownerRecord.owner;
      const release = await ownerRequest(f.config, { op: 'release', session_id: f.id }).then(
        (value) => ({ status: value.status }),
        (error) => ({ reason: error.message }),
      );
      assert.deepEqual(
        { release, ownerAlive: await ownerAlive(owner) },
        { release: { reason: 'RUNTIME_IDLE_UNCONFIRMED' }, ownerAlive: true },
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
      } else
        assert.equal(
          (await ownerRequest(f.config, { op: 'release', session_id: f.id })).status,
          'released',
        );
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
      f.bridge.send({ session_id: f.id, request_id: 'race-' + i, text: 'NEVER_ADMITTED' }),
    ),
  );
  assert.ok(sends.every((s) => s.reason === 'COLD_REACQUIRE_BLOCKED'));
  assert.equal(f.bridge.pool.instances.size, 0);
});
