import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import {
  readClaim,
  registryTransaction,
  assertNoOtherLiveOwner,
  processIdentity,
  ownerAlive,
  waitOwnerExit,
  reserveOwner,
  releaseOwner,
  claimFile,
  AttachedRuntime,
} from '../src/attachments.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import joinExtension from '../src/join-extension.mjs';
const base = path.resolve('.'),
  delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label = 'fixture condition', ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error('Timed out: ' + label);
}
async function exists(file) {
  try {
    await fs.stat(file);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
async function fixture(t, source = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-idle-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const extension = path.join(dir, 'fixture.mjs');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises'; const dir=${JSON.stringify(dir)};
    const delay=ms=>new Promise(r=>setTimeout(r,ms));
    async function mark(name){await fs.writeFile(dir+'/'+name,'yes');}
    async function wait(name){for(;;){try{await fs.stat(dir+'/'+name);return;}catch(e){if(e.code!=='ENOENT')throw e;}await delay(10);}}
    export default pi=>{${source}};`,
  );
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [
      { folder: cwd, list: true, read: true, send: true, delete: true, stop: true, create: true },
    ],
  };
  config.piArgs.push(
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '-e',
    extension,
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  );
  await fs.mkdir(config.piRuntime.agentDir);
  await fs.writeFile(
    path.join(config.piRuntime.agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const configFile = path.join(dir, 'owner.json');
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  const cleanup = [];
  t.after(async () => {
    // Node runs after hooks in registration order. Release test gates and stop
    // external fixtures before Bridge drains work or their files are removed.
    for (const close of cleanup) await close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const request = {
    op: 'handoff',
    session_id: session.id,
    requester: await processIdentity(),
    handoff_id: randomUUID(),
  };
  return {
    dir,
    cwd,
    config,
    configFile,
    bridge,
    cleanup,
    session,
    id: session.id,
    request,
    mark: (name) => fs.writeFile(path.join(dir, name), 'yes'),
  };
}
function transfer(f, options) {
  return ownerRequest(f.config, f.request, options);
}
async function cancel(f) {
  return ownerRequest(f.config, { ...f.request, op: 'handoff_cancel' });
}

for (const stage of ['running', 'busy_handoff', 'handoff_eof', 'release_eof'])
  test(`delete ends the session during ${stage}`, { timeout: 15000 }, async (t) => {
    const f = await fixture(
      t,
      `
      pi.on('agent_before_settle', async()=>{await mark('settling');await wait('settle');});
      pi.on('session_shutdown', async()=>{await mark('shutdown');await wait('shutdown-go');});
    `,
    );
    f.cleanup.push(() => Promise.all([f.mark('settle'), f.mark('shutdown-go')]));
    f.config.attachmentExitTimeoutMs = 50;
    await f.bridge.send({ session_id: f.id, text: 'DELETE_OVERRIDES_LIFECYCLE' });
    const rpc = f.bridge.pool.get(f.id),
      owner = structuredClone(rpc.ownerRecord.owner);
    await until(() => exists(path.join(f.dir, 'settling')));
    let lifecycle;
    if (stage === 'release_eof') {
      // Exercise explicit local release rather than racing automatic release.
      rpc.autoReleaseWanted = false;
      await rpc.autoReleaseTask;
      await f.mark('settle');
      await rpc.waitForHandoff();
      lifecycle = f.bridge.releaseForLocal({ session_id: f.id });
    } else if (stage !== 'running') lifecycle = transfer(f);
    const outcome = lifecycle?.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    if (lifecycle) await until(() => f.bridge.handoffs.has(f.id));
    if (stage === 'handoff_eof') await f.mark('settle');
    if (['handoff_eof', 'release_eof'].includes(stage))
      await until(() => exists(path.join(f.dir, 'shutdown')));
    const deleted = await f.bridge.delete({ session_id: f.id });
    assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
    if (outcome)
      assert.ok((await outcome).error, 'cancelled lifecycle must not report a successful handoff');
    assert.equal(await ownerAlive(owner), false);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    assert.equal(f.bridge.handoffs.has(f.id), false);
    await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(f.config.stateDir, 'trash', deleted.restore_token + '.restore.json'),
        'utf8',
      ),
    );
    assert.match(await fs.readFile(manifest.trash_path, 'utf8'), /DELETE_OVERRIDES_LIFECYCLE/);
  });

test(
  'handoff drains queued work and awaits a slow native EOF shutdown before reserving latest history',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});
    pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');pi.appendEntry('shutdown-history',{complete:true});await mark('shutdown-done');});`,
    );
    f.cleanup.push(() => Promise.all([f.mark('settle'), f.mark('shutdown-go')]));
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: 'FIRST_HANDOFF' })).status,
      ),
      'Expected native prompt admission',
    );
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
    let killed = false;
    const kill = rpc.child.kill.bind(rpc.child);
    rpc.child.kill = (...args) => {
      killed = true;
      return kill(...args);
    };
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'QUEUED_HANDOFF',
          mode: 'follow_up',
        })
      ).status,
      'queued',
    );
    let finished = false;
    const joined = transfer(f).then((v) => {
      finished = true;
      return v;
    });
    await until(() => f.bridge.handoffs.has(f.id));
    t.mock.method(rpc, 'stopExecution', () =>
      assert.fail('join must reject new stop before native cancellation or withdrawal'),
    );
    const stopArgs = { session_id: f.id },
      stopReceipt = await f.bridge.stop(stopArgs);
    assert.equal(stopReceipt.status, 'rejected');
    assert.equal(stopReceipt.reason, 'HANDOFF_PENDING');

    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'NEVER_SENT' })).reason,
      'HANDOFF_PENDING',
    );
    const grants = f.config.grants;
    f.config.grants = [];
    for (const action of ['send', 'delete'])
      assert.equal(
        (
          await f.bridge[action]({
            session_id: f.id,

            ...(action === 'send' ? { text: 'NEVER_SENT' } : {}),
          })
        ).reason,
        'NOT_FOUND_OR_DENIED',
      );
    await assert.rejects(f.bridge.stop(stopArgs), /NOT_FOUND_OR_DENIED/);
    f.config.grants = grants;
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'NEVER_SENT' }), {
      code: 'HANDOFF_PENDING',
    });
    await until(() => exists(path.join(f.dir, 'settling')));
    assert.equal(finished, false);
    assert.equal(await ownerAlive(old.owner), true);
    await f.mark('settle');
    await until(() => exists(path.join(f.dir, 'shutdown')));
    assert.equal(finished, false);
    assert.equal(await ownerAlive(old.owner), true);
    assert.equal(killed, false);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, old.generation);
    await f.mark('shutdown-go');
    const result = await joined;
    assert.equal(result.status, 'reserved');
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(rpc.child.signalCode, null);
    assert.equal(killed, false);
    assert.equal(await ownerAlive(old.owner), false);
    assert.equal(await exists(path.join(f.dir, 'shutdown-done')), true);
    const rows = (await fs.readFile(f.session.file, 'utf8')).trim().split('\n').map(JSON.parse);
    for (const text of ['FIRST_HANDOFF', 'QUEUED_HANDOFF'])
      assert.equal(
        rows.filter(
          (e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes(text),
        ).length,
        1,
      );
    assert.equal(rows.filter((e) => e.message?.role === 'assistant').length, 2);
    assert.ok(rows.some((e) => e.customType === 'shutdown-history'));
    const held = await readClaim(f.config.attachmentDir, f.session);
    assert.equal(held.generation, result.generation);
    assert.equal(held.owner.pid, process.pid);
    assert.equal(held.noColdReacquire, undefined);
    assert.equal(held.kind, 'handoff');
    assert.equal(held.phase, 'reserved');
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
    await cancel(f);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: 'AFTER_CANCEL' })).status,
      'started',
    );
  },
);

test(
  'owner release and handoff both prove quiescence after overlapping queued RPC input',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      "pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});",
    );
    f.cleanup.push(() => f.mark('settle'));
    const rpc = await f.bridge.pool.resolve(f.session);
    assert.equal(
      (await rpc.command({ type: 'prompt', message: 'FIRST_INPUT' })).disposition,
      'started',
    );
    assert.equal(
      (
        await rpc.command({
          type: 'prompt',
          message: 'QUEUED_INPUT',
          streamingBehavior: 'followUp',
        })
      ).disposition,
      'queued',
    );
    await until(() => exists(path.join(f.dir, 'settling')));
    await f.mark('settle');
    const observer = new AttachedRuntime(f.config, f.session, rpc.ownerRecord);
    await until(async () => {
      const state = await rpc.state(),
        observed = await observer.state();
      return (
        !state.isStreaming &&
        !state.isCompacting &&
        state.pendingMessageCount === 0 &&
        observed.isIdle &&
        !observed.hasPendingMessages &&
        rpc.settlement.sequence >= rpc.requiredSettlementSequence
      );
    }, 'native settled and queues drained');
    // All queued RPC work is accounted for by ACK and settlement evidence.
    assert.equal((await observer.state()).pendingInputs, 0);
    // The immediate owner release must use the same completed-work evidence.
    await rpc.assertReleasable();
    const result = await transfer(f);
    assert.equal(result.status, 'reserved');
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(rpc.child.signalCode, null);
    await cancel(f);
  },
);

test(
  'join waits for an admitted stop to finish its final queue recovery before fencing RPC',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session),
      dispatch = rpc.dispatch;
    const entered = Promise.withResolvers(),
      finish = Promise.withResolvers(),
      controls = [];
    let clears = 0;
    t.mock.method(rpc, 'dispatch', async function (command, ...args) {
      if (['clear_queue', 'abort', 'abort_bash'].includes(command.type))
        controls.push(command.type);
      if (command.type === 'clear_queue' && ++clears === 2) {
        entered.resolve();
        await finish.promise;
      }
      return dispatch.call(this, command, ...args);
    });
    const stopped = f.bridge.stop({ session_id: f.id });
    await entered.promise;
    const joined = transfer(f);
    try {
      await until(() => f.bridge.handoffs.has(f.id));
      assert.notEqual(rpc.handoffPending, true);
      assert.equal(rpc.gracefulExitPromise, undefined);
      const rejected = await f.bridge.stop({ session_id: f.id });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.reason, 'HANDOFF_PENDING');
    } finally {
      finish.resolve();
    }
    assert.equal((await stopped).status, 'accepted');
    assert.equal((await joined).status, 'reserved');
    assert.deepEqual(controls, ['clear_queue', 'abort', 'abort_bash', 'clear_queue']);
    assert.equal(rpc.child.exitCode, 0);
    await cancel(f);
  },
);

test(
  'join arriving during stop owner lookup rejects the undispatched stop with a definite receipt',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session),
      forRead = f.bridge.pool.forRead;
    const entered = Promise.withResolvers(),
      finish = Promise.withResolvers();
    let held = false;
    t.mock.method(f.bridge.pool, 'forRead', async function (session) {
      if (!held) {
        held = true;
        entered.resolve();
        await finish.promise;
      }
      return forRead.call(this, session);
    });
    t.mock.method(rpc, 'stopExecution', () => assert.fail('stop was not yet dispatched'));
    const args = { session_id: f.id },
      stopped = f.bridge.stop(args);
    await entered.promise;
    const joined = transfer(f);
    try {
      await until(() => f.bridge.handoffs.has(f.id));
    } finally {
      finish.resolve();
    }
    const receipt = await stopped;
    assert.equal(receipt.status, 'rejected');
    assert.equal(receipt.reason, 'HANDOFF_PENDING');
    assert.equal((await joined).status, 'reserved');

    await cancel(f);
  },
);

test(
  'an uncertain stop ACK remains a handoff barrier even after the stop lock ends',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session),
      receive = rpc.receiveResponse;
    let held;
    t.mock.method(rpc, 'receiveResponse', function (event, generation) {
      if (event.type === 'response' && event.command === 'abort') {
        held = { event, generation };
        return;
      }
      return receive.call(this, event, generation);
    });
    ackTimeout(t, ['abort']);
    const args = { session_id: f.id },
      receipt = await f.bridge.stop(args);
    assert.equal(receipt.status, 'unknown');
    assert.equal(receipt.reason, 'ACK_TIMEOUT');
    await until(() => held);
    assert.equal(f.bridge.locks.has(`stop:${f.id}`), false);
    const joined = transfer(f);
    await until(() => rpc.handoffPending);
    await delay(100);
    assert.equal(rpc.gracefulExitPromise, undefined);
    assert.equal(rpc.alive, true);

    receive.call(rpc, held.event, held.generation);
    assert.equal((await joined).status, 'reserved');
    assert.equal(rpc.child.exitCode, 0);
    await cancel(f);
  },
);

test(
  'unrelated custom settlement cannot clear held Bridge prompt preflight; late ACK and its run must finish',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('input',async event=>{if(event.text==='HELD_PREFLIGHT'){
    pi.sendMessage({customType:'unrelated',content:'CUSTOM_TURN',display:false},{triggerTurn:true});await mark('preflight');await wait('preflight-go');}return {action:'continue'};});`,
    );
    f.cleanup.push(() => f.mark('preflight-go'));
    ackTimeout(t, ['prompt']);
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'HELD_PREFLIGHT',
        })
      ).status,
      'unknown',
    );
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
    await until(() => rpc.settlement.sequence === 1);
    assert.equal((await rpc.state()).isStreaming, false);
    assert.ok(rpc.promptAdmission);
    let done = false;
    const joined = transfer(f).then((x) => {
      done = true;
      return x;
    });
    await until(() => f.bridge.handoffs.has(f.id));
    await delay(100);
    assert.equal(done, false);
    assert.equal(await ownerAlive(old.owner), true);
    await f.mark('preflight-go');
    await joined;
    assert.equal(rpc.settlement.sequence, 2);
    assert.equal(rpc.child.exitCode, 0);
    const raw = await fs.readFile(f.session.file, 'utf8');
    assert.ok(raw.includes('HELD_PREFLIGHT'));
    assert.ok(raw.includes('Synthetic response 2.'));
    await cancel(f);
  },
);

test(
  'handled custom turn still waits for its settled hooks even when streaming is already false',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.registerCommand('custom-turn',{handler:async()=>{pi.sendMessage({customType:'custom',content:'CUSTOM_SETTLED_HOOK',display:false},{triggerTurn:true});}});
    pi.on('agent_settled',async()=>{await mark('settled-hook');await wait('settled-go');});`,
    );
    f.cleanup.push(() => f.mark('settled-go'));
    assert.equal(
      (await f.bridge.send({ session_id: f.id, text: '/custom-turn' })).status,
      'handled',
    );
    const rpc = f.bridge.pool.get(f.id);
    await until(() => exists(path.join(f.dir, 'settled-hook')));
    assert.equal((await rpc.state()).isStreaming, false);
    assert.equal(rpc.settlement.sequence, 0);
    let done = false;
    const joined = transfer(f).then((x) => {
      done = true;
      return x;
    });
    await until(() => f.bridge.handoffs.has(f.id));
    await delay(100);
    assert.equal(done, false);
    assert.equal(rpc.gracefulExitPromise, undefined);
    await f.mark('settled-go');
    await joined;
    assert.equal(rpc.settlement.sequence, 1);
    await cancel(f);
  },
);

test(
  'disconnect cancellation before EOF resumes admissions, preserves the current run and permits a single new join',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});`,
    );
    f.cleanup.push(() => f.mark('settle'));
    await f.bridge.send({ session_id: f.id, text: 'CANCEL_WAIT' });
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
    const controller = new AbortController(),
      joined = transfer(f, { signal: controller.signal });
    const rejected = assert.rejects(joined, /HANDOFF_CANCELLED/);
    await until(() => rpc.handoffPending);
    await assert.rejects(transfer(f), /HANDOFF_PENDING/);
    await ownerRequest(f.config, { ...f.request, op: 'handoff_cancel', handoff_id: randomUUID() });
    assert.equal(rpc.handoffPending, true);
    controller.abort();
    await rejected;
    await until(() => !f.bridge.handoffs.has(f.id));
    assert.equal(await ownerAlive(old.owner), true);
    assert.notEqual((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'PRESERVED_QUEUE',
          mode: 'follow_up',
        })
      ).status,
      'queued',
    );
    f.request.handoff_id = randomUUID();
    const retried = transfer(f);
    await f.mark('settle');
    assert.equal((await retried).status, 'reserved');
    await cancel(f);
  },
);

test(
  'cancellation during shutdown leaves no reservation and never escalates a slow hook',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
    );
    f.cleanup.push(() => f.mark('shutdown-go'));
    const rpc = await f.bridge.pool.resolve(f.session),
      old = structuredClone(rpc.ownerRecord),
      controller = new AbortController();
    const joined = transfer(f, { signal: controller.signal }),
      rejected = assert.rejects(joined, /HANDOFF_CANCELLED/);
    await until(() => exists(path.join(f.dir, 'shutdown')));
    controller.abort();
    await rejected;
    await delay(1600);
    assert.equal(await ownerAlive(old.owner), true);
    await f.mark('shutdown-go');
    await until(() => !f.bridge.handoffs.has(f.id));
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
  },
);

test(
  'independent extension input completes before lossless handoff',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.registerCommand('start-external',{handler:async()=>{pi.sendUserMessage('EXTERNAL_HELD');}});
    pi.on('before_agent_start',async event=>{if(event.prompt==='EXTERNAL_HELD'){await mark('external');await wait('external-go');}});`,
    );
    f.cleanup.push(() => f.mark('external-go'));
    const rpc = await f.bridge.pool.resolve(f.session);
    await rpc.command({ type: 'prompt', message: '/start-external' });
    await until(() => exists(path.join(f.dir, 'external')));
    const old = structuredClone(rpc.ownerRecord);
    assert.equal((await rpc.state()).isStreaming, true);
    const joining = transfer(f);
    void joining.catch(() => {});
    await until(() => rpc.handoffPending);
    assert.equal(await ownerAlive(old.owner), true);
    assert.equal(rpc.gracefulExitPromise, undefined);
    await f.mark('external-go');
    assert.equal((await joining).status, 'reserved');
    assert.equal(rpc.settlement.sequence, 1);
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(rpc.child.signalCode, null);
    await cancel(f);
  },
);

test(
  'owned RPC cancels unsupported dialogs and reports them without approving',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('input',async(event,ctx)=>{
    if(event.text!=='DIALOGS')return {action:'handled'};
    ctx.ui.notify('unattended notice');
    const values=[ctx.hasUI,await ctx.ui.confirm('Approval','Allow?'),await ctx.ui.select('Choice',['yes']),await ctx.ui.input('Text'),await ctx.ui.editor('Edit','draft')];
    pi.appendEntry('dialog-results',values.map(v=>v??null));
    return {action:'handled'};
  });`,
    );
    const sent = await f.bridge.send({
      session_id: f.id,

      text: 'DIALOGS',
    });
    assert.ok(['started', 'queued', 'handled'].includes(sent.status), JSON.stringify(sent));
    assert.equal(sent.status, 'handled');
    assert.equal(sent.reason, 'EXTENSION_UI_CANCEL_SENT');
    assert.equal(sent.ui, undefined);
    await until(() => !f.bridge.pool.get(f.id) && !f.bridge.autoReleases.size);
    assert.deepEqual(
      (await fs.readFile(f.session.file, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse)
        .find((e) => e.customType === 'dialog-results').data,
      [true, false, null, null, null],
    );
    assert.equal((await f.bridge.list({})).sessions[0].status.state, 'saved');
    assert.equal((await f.bridge.stop({ session_id: f.id })).status, 'skipped');
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: 'NO_DIALOG' })).status,
      ),
      'Expected native prompt admission',
    );
  },
);

test(
  'CLI input hooks cannot hide independent preflight from the RPC observer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `
    pi.registerCommand('start-independent',{handler:async()=>{pi.sendUserMessage('INDEPENDENT_INPUT');}});
    pi.on('input',async event=>{if(event.text==='INDEPENDENT_INPUT'){await mark('input-held');await wait('input-go');}return {action:'continue'};});
  `,
    );
    f.cleanup.push(() => f.mark('input-go'));
    const rpc = await f.bridge.pool.resolve(f.session);
    assert.equal(
      (await rpc.command({ type: 'prompt', message: '/start-independent' })).disposition,
      'handled',
    );
    await until(() => exists(path.join(f.dir, 'input-held')));
    assert.equal(rpc.promptAdmission, null);
    assert.equal((await rpc.state()).isStreaming, false);
    const observer = new AttachedRuntime(f.config, f.session, rpc.ownerRecord);
    assert.equal((await observer.state()).pendingInputs, 1);
    const joining = transfer(f);
    void joining.catch(() => {});
    await until(() => f.bridge.handoffs.has(f.id));
    assert.equal(rpc.child.stdin.writableEnded, false);
    await f.mark('input-go');
    assert.equal((await joining).status, 'reserved');
    const entries = (await fs.readFile(f.session.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(
      entries.some(
        (e) =>
          e.message?.role === 'user' &&
          JSON.stringify(e.message.content).includes('INDEPENDENT_INPUT'),
      ),
    );
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(rpc.child.signalCode, null);
    await cancel(f);
  },
);

for (const settings of [false, true])
  test(
    settings
      ? 'prompt settings cannot queue when an input hook starts concurrent work'
      : 'idle_only cannot queue when an input hook starts concurrent work',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(
        t,
        `
    pi.on('input',async event=>{if(event.text==='IDLE_RACE'){
      pi.sendMessage({customType:'race',content:'CONCURRENT',display:false},{triggerTurn:true});
      await wait('concurrent-started');
    }return {action:'continue'};});
    pi.on('before_agent_start',async()=>{await mark('concurrent-started');await wait('concurrent-go');});
  `,
      );
      f.cleanup.push(() => f.mark('concurrent-go'));
      const result = await f.bridge.send({
        session_id: f.id,

        text: 'IDLE_RACE',
        mode: settings ? 'steer' : 'idle_only',
        ...(settings ? { thinking_level: 'off' } : {}),
      });
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason, 'PI_REJECTED');
      assert.equal((await f.bridge.pool.get(f.id).state()).pendingMessageCount, 0);
      await f.mark('concurrent-go');
    },
  );

test('cancel during pre-EOF recovery drain keeps the writer', { timeout: 15000 }, async (t) => {
  const f = await fixture(t),
    rpc = await f.bridge.pool.resolve(f.session),
    controller = new AbortController();
  const entered = Promise.withResolvers(),
    resume = Promise.withResolvers(),
    drain = rpc.drainAcks;
  let first = true;
  f.cleanup.push(() => resume.resolve());
  t.mock.method(rpc, 'drainAcks', async function () {
    if (first) {
      first = false;
      entered.resolve();
      await resume.promise;
    }
    return drain.call(this);
  });
  const joined = transfer(f, { signal: controller.signal }),
    rejected = assert.rejects(joined, /HANDOFF_CANCELLED/);
  await entered.promise;
  await cancel(f); // Observe server-side cancellation before allowing EOF preparation to resume.
  resume.resolve();
  await rejected;
  await until(() => !f.bridge.handoffs.has(f.id));
  assert.equal(rpc.child.stdin.writableEnded, false);
  assert.notEqual((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
  assert.equal(rpc.alive, true);
});

test(
  'external owners, abnormal exits, stale cancellation and identity errors never report normal handoff',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',()=>{process.exitCode=7;process.exit(7);});`,
    );
    const external = await reserveOwner(f.config.attachmentDir, f.session, 'tui');
    await assert.rejects(transfer(f), /LIVE_OWNER_UNREACHABLE/);
    assert.equal(await ownerAlive(external.owner), true);
    await releaseOwner(f.config.attachmentDir, f.session, external);
    const rpc = await f.bridge.pool.resolve(f.session),
      dispatch = rpc.dispatch;
    rpc.dispatch = async () => ({ sessionFile: '/wrong', sessionId: 'wrong' });
    await assert.rejects(transfer(f), /RUNTIME_SESSION_CHANGED/);
    assert.equal(rpc.gracefulExitPromise, undefined);
    rpc.dispatch = dispatch;
    await assert.rejects(transfer(f), /RUNTIME_EXIT_ABNORMAL/);
    assert.equal(rpc.child.exitCode, 7);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    const retry = await transfer(f);
    await ownerRequest(f.config, { ...f.request, op: 'handoff_cancel', handoff_id: randomUUID() });
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, retry.generation);
    await cancel(f);
  },
);

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
for (const action of ['cancel', 'delete'])
  test(`${action} during reservation validation never starts native switching or terminates the requester`, async (t) => {
    const f = await fixture(t),
      priorConfig = process.env.PI_MCP_OWNER_CONFIG,
      priorDir = process.env.PI_MCP_ATTACH_DIR;
    process.env.PI_MCP_OWNER_CONFIG = f.configFile;
    process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      open = fs.open,
      file = claimFile(f.config.attachmentDir, f.session);
    let gated = false,
      switches = 0;
    t.mock.method(fs, 'open', async function (target, ...args) {
      if (target === file && !gated) {
        let record;
        try {
          record = JSON.parse(readFileSync(file, 'utf8'));
        } catch {}
        // The first read after owner control publishes the reservation is the
        // companion's asynchronous validation, after it received the response.
        if (record?.phase === 'reserved' && record.handoffId) {
          gated = true;
          entered.resolve();
          await release.promise;
        }
      }
      return open.call(this, target, ...args);
    });
    const commands = {},
      shortcuts = {};
    const ctx = {
      mode: 'tui',
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      ui: { notify: () => {} },
      switchSession: async () => {
        switches++;
        return { cancelled: true };
      },
    };
    try {
      joinExtension({
        on: () => {},
        registerShortcut: (name, value) => (shortcuts[name] = value.handler),
        registerCommand: (name, value) => (commands[name] = value.handler),
      });
      const joined = commands['bridge-join'](f.id, ctx);
      await entered.promise;
      if (action === 'delete') {
        const deleted = await f.bridge.delete({ session_id: f.id });
        assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
        assert.equal(await ownerAlive(f.request.requester), true);
        await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
      } else await shortcuts['ctrl+alt+j'](ctx);
      release.resolve();
      await joined;
      assert.equal(switches, 0);
      assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    } finally {
      release.resolve();
      t.mock.restoreAll();
      if (priorConfig === undefined) delete process.env.PI_MCP_OWNER_CONFIG;
      else process.env.PI_MCP_OWNER_CONFIG = priorConfig;
      if (priorDir === undefined) delete process.env.PI_MCP_ATTACH_DIR;
      else process.env.PI_MCP_ATTACH_DIR = priorDir;
    }
  });

test('an uncertain native switch exception retains its live reservation instead of allowing a second writer', async (t) => {
  const f = await fixture(t),
    priorConfig = process.env.PI_MCP_OWNER_CONFIG,
    priorDir = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_OWNER_CONFIG = f.configFile;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const commands = {},
    notices = [];
  try {
    joinExtension({
      on: () => {},
      registerShortcut: () => {},
      registerCommand: (name, value) => (commands[name] = value.handler),
    });
    await commands['bridge-join'](f.id, {
      mode: 'tui',
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      ui: { notify: (text) => notices.push(text) },
      switchSession: async () => {
        throw new Error('fixture failure after target open');
      },
    });
    const held = await readClaim(f.config.attachmentDir, f.session);
    assert.equal(held.kind, 'handoff');
    assert.equal(held.phase, 'opening');
    assert.equal(held.owner.pid, process.pid);
    assert.equal(held.noColdReacquire, undefined);
    assert.ok(notices.some((x) => x.includes('reservation is retained')));
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
    await ownerRequest(f.config, {
      ...f.request,
      op: 'handoff_cancel',
      handoff_id: held.handoffId,
    });
  } finally {
    if (priorConfig === undefined) delete process.env.PI_MCP_OWNER_CONFIG;
    else process.env.PI_MCP_OWNER_CONFIG = priorConfig;
    if (priorDir === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = priorDir;
  }
});

for (const mode of [
  'one command during active work',
  'later switch veto and explicit retry',
  'cancel shortcut then explicit retry',
  'delete during native switch',
  'delete during cancelled switch',
])
  test(`ordinary native TUI joins with latest history (${mode})`, { timeout: 35000 }, async (t) => {
    const laterVeto = mode.startsWith('later'),
      cancelWait = mode.startsWith('cancel'),
      deleting = mode.startsWith('delete'),
      cancelDelete = mode === 'delete during cancelled switch';
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});
    pi.on('session_shutdown',()=>{pi.appendEntry('final-owned-history',{latest:true});});`,
    );
    f.cleanup.push(() => Promise.all([f.mark('settle'), f.mark('open-go')]));
    const other = await savedSession(f.bridge),
      sessionB = await f.bridge.session(other.session_id);
    const tuiExtension = path.join(f.dir, 'tui.mjs');
    await fs.writeFile(
      tuiExtension,
      `import fs from 'node:fs/promises';const dir=${JSON.stringify(f.dir)};let veto=${laterVeto};
    export default pi=>{pi.on('session_start',async(event,ctx)=>{if(event.reason==='resume')await fs.writeFile(dir+'/opened.json',JSON.stringify(ctx.sessionManager.getEntries()));});
      pi.registerCommand('fixture-switch-back',{handler:async(_args,ctx)=>{await ctx.switchSession(${JSON.stringify(sessionB.file)});await fs.writeFile(dir+'/switched-back','yes');}});
      pi.registerCommand('fixture-switch-conflict',{handler:async(_args,ctx)=>{const result=await ctx.switchSession(${JSON.stringify(f.session.file)});await fs.writeFile(dir+'/conflict.json',JSON.stringify({result,file:ctx.sessionManager.getSessionFile()}));}});
      pi.on('session_before_switch',async event=>{
        if(event.targetSessionFile!==${JSON.stringify(f.session.file)})return;
        if(veto){veto=false;return {cancel:true};}
        if(${deleting}){await fs.writeFile(dir+'/opening','yes');while(!await fs.stat(dir+'/open-go').catch(()=>null))await new Promise(r=>setTimeout(r,10));if(${cancelDelete})return {cancel:true};}
      });};`,
    );
    const args = [
      process.execPath,
      nativePiCli,
      '--offline',
      '--session',
      sessionB.file,
      '--no-extensions',
      '--no-context-files',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-tools',
      '-e',
      path.join(base, 'test/fixtures/faux-extension.mjs'),
      '-e',
      path.join(base, 'src/attach-extension.mjs'),
      '-e',
      tuiExtension,
      '--provider',
      'bridge-fixture',
      '--model',
      'deterministic',
      '--thinking',
      'off',
    ];
    const tui = spawn('script', ['-qefc', args.map(quote).join(' '), '/dev/null'], {
      cwd: f.cwd,
      env: {
        PATH: process.env.PATH,
        HOME: f.dir,
        PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir,
        PI_MCP_OWNER_CONFIG: f.configFile,
        PI_MCP_ATTACH_DIR: f.config.attachmentDir,
        PI_OFFLINE: '1',
        TERM: 'xterm-256color',
        LANG: 'C.UTF-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let terminal = '',
      owner;
    tui.stdout.on('data', (x) => (terminal += x.toString()));
    tui.stderr.on('data', (x) => (terminal += x.toString()));
    f.cleanup.push(async () => {
      if (owner && (await ownerAlive(owner.owner))) {
        process.kill(owner.owner.pid, 'SIGTERM');
        await waitOwnerExit(owner.owner);
      }
      tui.stdin.destroy();
      if (tui.exitCode === null) tui.kill('SIGTERM');
    });
    await until(async () => {
      owner = await readClaim(f.config.attachmentDir, sessionB);
      return owner?.phase === 'ready';
    }, 'TUI startup');
    for (const command of ['bridge-join', 'bridge-join:1']) {
      const denied = await f.bridge.send({
        session_id: sessionB.id,

        text: `/${command} ${f.id}`,
      });
      assert.equal(denied.status, 'rejected');
      assert.equal(denied.reason, 'OWNER_LOCAL_COMMAND_REQUIRED');
    }
    await f.bridge.send({ session_id: f.id, text: 'NATIVE_JOIN_LATEST' });
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
    if (!laterVeto && !cancelWait && !deleting) {
      tui.stdin.write('/fixture-switch-conflict\r');
      await until(() => exists(path.join(f.dir, 'conflict.json')), 'conflict cancellation');
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.dir, 'conflict.json'), 'utf8')), {
        result: { cancelled: true },
        file: sessionB.file,
      });
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, old.generation);
      assert.equal(
        (await readClaim(f.config.attachmentDir, sessionB)).generation,
        owner.generation,
      );
    }
    tui.stdin.write(`/bridge-join ${f.id}\r`);
    await until(() => f.bridge.handoffs.has(f.id), 'join fence');
    await until(() => exists(path.join(f.dir, 'settling')));
    assert.equal(await ownerAlive(old.owner), true);
    assert.equal(await exists(path.join(f.dir, 'opened.json')), false);
    if (cancelWait) {
      tui.stdin.write('\x1b\x0a');
      await until(() => !f.bridge.handoffs.has(f.id), 'native cancellation');
      assert.equal(await ownerAlive(old.owner), true);
      assert.equal(rpc.gracefulExitPromise, undefined);
      await until(() => terminal.includes('Join cancelled.'), 'cancellation notice');
      tui.stdin.write(`/bridge-join ${f.id}\r`);
      await until(() => f.bridge.handoffs.has(f.id), 'new explicit join');
    }
    await f.mark('settle');
    if (deleting) {
      await until(() => exists(path.join(f.dir, 'opening')), 'later asynchronous switch hook');
      const deletion = f.bridge.delete({ session_id: f.id });
      // The delete gate now excludes any new writer; this admitted native
      // switch is the only operation allowed to finish registering its writer.
      await until(async () => {
        try {
          await registryTransaction(f.config.attachmentDir, () =>
            assertNoOtherLiveOwner(f.config.attachmentDir, f.session),
          );
          return false;
        } catch (error) {
          if (error.code !== 'LIVE_OWNER_UNREACHABLE') throw error;
          return true;
        }
      }, 'delete authority');
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      assert.equal(await ownerAlive(owner.owner), true);
      assert.equal(
        (await readClaim(f.config.attachmentDir, sessionB)).generation,
        owner.generation,
      );
      await f.mark('open-go');
      const deleted = await deletion;
      assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
      assert.equal(await ownerAlive(owner.owner), cancelDelete);
      await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
      assert.ok(await fs.stat(sessionB.file));
      if (cancelDelete) {
        assert.equal(
          (await readClaim(f.config.attachmentDir, sessionB)).generation,
          owner.generation,
        );
        assert.equal(await exists(path.join(f.dir, 'opened.json')), false);
      } else assert.equal(await readClaim(f.config.attachmentDir, sessionB), null);
      const manifest = JSON.parse(
        await fs.readFile(
          path.join(f.config.stateDir, 'trash', deleted.restore_token + '.restore.json'),
          'utf8',
        ),
      );
      assert.match(await fs.readFile(manifest.trash_path, 'utf8'), /NATIVE_JOIN_LATEST/);
      return;
    }
    if (laterVeto) {
      await until(() => terminal.includes('Session switch cancelled'), 'later veto');
      await until(async () => {
        const r = await readClaim(f.config.attachmentDir, f.session);
        return r === null;
      }, 'reservation cleanup');
      // A cancelled native switch is an explicit new request, never an automatic
      // retry loop. The second request opens saved history without another child.
      tui.stdin.write(`/bridge-join ${f.id}\r`);
    }
    await until(() => exists(path.join(f.dir, 'opened.json')), 'native resume');
    assert.equal(await ownerAlive(old.owner), false);
    assert.equal(rpc.child.exitCode, 0);
    const entries = JSON.parse(await fs.readFile(path.join(f.dir, 'opened.json'), 'utf8'));
    assert.ok(entries.some((e) => e.customType === 'final-owned-history'));
    assert.equal(
      entries.filter(
        (e) =>
          e.message?.role === 'user' &&
          JSON.stringify(e.message.content).includes('NATIVE_JOIN_LATEST'),
      ).length,
      1,
    );
    assert.ok(
      entries.some(
        (e) =>
          e.message?.role === 'assistant' &&
          JSON.stringify(e.message.content).includes('Synthetic response 1.'),
      ),
    );
    const local = await readClaim(f.config.attachmentDir, f.session);
    assert.equal(local.kind, 'tui');
    assert.equal(local.phase, 'ready');
    assert.equal(local.owner.pid, owner.owner.pid);
    assert.equal(local.noColdReacquire, undefined);
    assert.equal(f.bridge.pool.get(f.id), null);
    assert.ok((await f.bridge.read({ session_id: f.id })).items.length > 0);
    if (!laterVeto && !cancelWait) {
      tui.stdin.write('/fixture-switch-back\r');
      await until(() => exists(path.join(f.dir, 'switched-back')), 'native switch-away');
      assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
      assert.equal(
        (await f.bridge.send({ session_id: f.id, text: 'AFTER_SWITCH_AWAY' })).status,
        'started',
      );
      await until(() => !f.bridge.pool.get(f.id) && !f.bridge.autoReleases.size);
      process.kill(owner.owner.pid, 'SIGTERM');
      await waitOwnerExit(owner.owner);
      assert.equal(
        (await f.bridge.send({ session_id: f.id, text: 'AFTER_B_EXIT' })).status,
        'started',
      );
    }
  });

test(
  'exit during pre-EOF recovery is observed without waiting for another exit event',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session);
    t.mock.method(rpc, 'drainAcks', async () => {
      if (rpc.exited) return;
      await new Promise((resolve) => {
        rpc.child.once('exit', resolve);
        rpc.child.kill('SIGTERM');
      });
    });
    await assert.rejects(rpc.gracefulExit(), /RUNTIME_EXIT_BEFORE_EOF|RUNTIME_SESSION_CHANGED/);
    assert.equal(rpc.exited, true);
    assert.equal(rpc.child.stdin.writableEnded, false);
  },
);

test(
  'startup UI fails with a lifecycle reason before a reader can consume cancellation',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_start',async(_event,ctx)=>{await ctx.ui.confirm('Startup','Continue?');await mark('startup-after');});`,
    );
    await assert.rejects(f.bridge.pool.resolve(f.session), (error) => {
      assert.equal(error.code, 'EXTENSION_UI_STARTUP_UNAVAILABLE');
      assert.deepEqual(error.ui, {
        cancel_sent: [],
        completion: 'unconfirmed',
        unavailable: [{ phase: 'startup', methods: ['confirm'] }],
      });
      return true;
    });
    const receipt = await f.bridge.create({
      project: f.cwd,

      text: 'x',
    });
    assert.equal(receipt.send.reason, 'EXTENSION_UI_STARTUP_UNAVAILABLE');
    assert.equal(receipt.send.ui, undefined);
    assert.equal(await exists(path.join(f.dir, 'startup-after')), false);
  },
);
for (const timeout of [undefined, 100])
  test(
    `shutdown UI warns without blocking normal handoff (${timeout})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        `pi.on('session_shutdown',async(_event,ctx)=>{await mark('shutdown-before');await ctx.ui.confirm('Shutdown','Continue?',${timeout === undefined ? 'undefined' : JSON.stringify({ timeout })});await mark('shutdown-after');});`,
      );
      const rpc = await f.bridge.pool.resolve(f.session),
        owner = structuredClone(rpc.ownerRecord.owner),
        result = await transfer(f);
      assert.equal(result.status, 'reserved');
      assert.deepEqual(result.ui.cancel_sent, []);
      assert.deepEqual(result.ui.unavailable, [{ phase: 'shutdown', methods: ['confirm'] }]);
      assert.equal(rpc.child.exitCode, 0);
      assert.equal(await ownerAlive(owner), false);
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).kind, 'handoff');
      if (timeout !== undefined)
        assert.equal(await exists(path.join(f.dir, 'shutdown-after')), true);
    },
  );

test(
  'create and late recovery retain observed UI facts while admission remains unknown',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('input',async(event,ctx)=>{await ctx.ui.confirm('Input','Continue?');if(event.text==='LATE_UI'){await mark('ui-held');await wait('ui-go');}return {action:'handled'};});`,
    );
    f.cleanup.push(() => f.mark('ui-go'));
    const success = await f.bridge.create({
      project: f.cwd,

      text: 'NORMAL_UI',
    });
    assert.equal(success.send.reason, 'EXTENSION_UI_CANCEL_SENT');
    ackTimeout(t, ['prompt']);
    const first = await f.bridge.create({
      project: f.cwd,

      text: 'LATE_UI',
    });
    assert.equal(first.status, 'unknown');
    assert.equal(first.send.reason, 'ACK_TIMEOUT');
    assert.equal(first.send.ui, undefined);
    await f.mark('ui-go');
    await until(() => !f.bridge.pool.get(first.session_id)?.promptAdmission);
  },
);

test(
  'join displays shutdown warnings before starting the native switch',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async(_event,ctx)=>{await ctx.ui.confirm('Shutdown','Continue?',{timeout:100});});`,
    );
    const rpc = await f.bridge.pool.resolve(f.session),
      notices = [],
      commands = {};
    let switched = false;
    joinExtension(
      {
        on: () => {},
        registerShortcut: () => {},
        registerCommand: (name, value) => (commands[name] = value.handler),
      },
      { file: f.configFile, dir: f.config.attachmentDir },
    );
    await commands['bridge-join'](f.id, {
      mode: 'tui',
      hasUI: true,
      isIdle: () => true,
      hasPendingMessages: () => false,
      ui: { notify: (text, severity) => notices.push({ text, severity }) },
      switchSession: async (file) => {
        assert.equal(file, f.session.file);
        assert.equal(rpc.child.exitCode, 0);
        assert.ok(
          notices.some(
            ({ text, severity }) => severity === 'warning' && text.includes('shutdown dialog'),
          ),
        );
        switched = true;
        return { cancelled: true };
      },
    });
    assert.equal(switched, true);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
  },
);

test(
  'owner-local release reports shutdown UI warnings while retaining its explicit pause',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async(_event,ctx)=>{await ctx.ui.confirm('Shutdown','Continue?',{timeout:100});await mark('shutdown-after');});`,
    );
    const rpc = await f.bridge.pool.resolve(f.session),
      result = await f.bridge.releaseForLocal({ session_id: f.id });
    assert.equal(result.status, 'released');
    assert.equal(result.no_cold_reacquire, true);
    assert.deepEqual(result.ui.unavailable, [{ phase: 'shutdown', methods: ['confirm'] }]);
    const claim = await readClaim(f.config.attachmentDir, f.session);
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(claim.owner, null);
    assert.equal(claim.noColdReacquire, true);
    assert.equal(await exists(path.join(f.dir, 'shutdown-after')), true);
  },
);
