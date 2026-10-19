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
  processIdentity,
  ownerAlive,
  waitOwnerExit,
  reserveOwner,
  releaseOwner,
  claimFile,
  AttachedRuntime,
} from '../src/attachments.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
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
    principal: 'idle-fixture',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: cwd }],
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
  const made = await savedSession(bridge, { folder_id: 'project', request_id: 'seed' }),
    session = await bridge.session(made.session_id);
  t.after(async () => {
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

test(
  'handoff drains queued work and awaits a slow native EOF shutdown before reserving latest history',
  { timeout: 25000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});
    pi.on('session_shutdown',async()=>{await mark('shutdown');await delay(2100);pi.appendEntry('shutdown-history',{complete:true});await mark('shutdown-done');});`,
    );
    t.after(() => f.mark('settle').catch(() => {}));
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'one', text: 'FIRST_HANDOFF' })).status,
      'accepted',
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
          request_id: 'two',
          text: 'QUEUED_HANDOFF',
          mode: 'follow_up',
        })
      ).disposition,
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
    const stopArgs = { session_id: f.id, request_id: 'fenced-stop' },
      stopReceipt = await f.bridge.stop(stopArgs);
    assert.equal(stopReceipt.status, 'rejected');
    assert.equal(stopReceipt.reason, 'HANDOFF_PENDING');
    assert.deepEqual(await f.bridge.stop(stopArgs), stopReceipt);
    for (const action of ['send', 'delete'])
      assert.equal(
        (
          await f.bridge[action]({
            session_id: f.id,
            request_id: 'fenced-' + action,
            text: 'NEVER_SENT',
          })
        ).reason,
        'HANDOFF_PENDING',
      );
    const grants = f.config.grants;
    f.config.grants = [];
    for (const action of ['send', 'delete'])
      assert.equal(
        (
          await f.bridge[action]({
            session_id: f.id,
            request_id: 'denied-' + action,
            text: 'NEVER_SENT',
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
    await delay(1650);
    assert.equal(finished, false);
    assert.equal(await ownerAlive(old.owner), true);
    assert.equal(killed, false);
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
    assert.equal(held.noColdReacquire, true);
    assert.equal(held.phase, 'starting');
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
    await cancel(f);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'released');
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'after-release', text: 'NEVER_SENT' }))
        .reason,
      'COLD_REACQUIRE_BLOCKED',
    );
  },
);

test(
  'owned handoff proves quiescence despite a sticky coarse preflight flag after queued RPC input',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      "pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});",
    );
    t.after(() => f.mark('settle').catch(() => {}));
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'first', text: 'FIRST_INPUT' })).status,
      'accepted',
    );
    const rpc = f.bridge.pool.get(f.id);
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          request_id: 'queued',
          text: 'QUEUED_INPUT',
          mode: 'follow_up',
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
        rpc.settlement.sequence >= rpc.handoffSettlement
      );
    }, 'native settled and queues drained');
    // A standalone observer cannot correlate overlapping inputs with their ACKs.
    // This coarse flag deliberately stays sticky; it is not a prerequisite for
    // the owned handoff, which has the full ACK and settlement evidence.
    assert.equal((await observer.state()).preparingUnconfirmed, true);
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
    const stopped = f.bridge.stop({ session_id: f.id, request_id: 'prior-stop' });
    await entered.promise;
    const joined = transfer(f);
    try {
      await until(() => f.bridge.handoffs.has(f.id));
      assert.notEqual(rpc.handoffPending, true);
      assert.equal(rpc.gracefulExitPromise, undefined);
      const rejected = await f.bridge.stop({ session_id: f.id, request_id: 'later-stop' });
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
    const args = { session_id: f.id, request_id: 'lookup-race' },
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
    assert.deepEqual(await f.bridge.stop(args), receipt);
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
    const args = { session_id: f.id, request_id: 'late-stop', timeout_ms: 50 },
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
    assert.deepEqual(await f.bridge.stop(args), receipt);
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
      `pi.on('before_agent_start',async event=>{if(event.prompt==='HELD_PREFLIGHT'){
    pi.sendMessage({customType:'unrelated',content:'CUSTOM_TURN',display:false},{triggerTurn:true});await mark('preflight');await wait('preflight-go');}});`,
    );
    t.after(() => f.mark('preflight-go').catch(() => {}));
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,
          request_id: 'held',
          text: 'HELD_PREFLIGHT',
          timeout_ms: 40,
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
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'custom', text: '/custom-turn' }))
        .disposition,
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
    t.after(() => f.mark('settle').catch(() => {}));
    await f.bridge.send({ session_id: f.id, request_id: 'one', text: 'CANCEL_WAIT' });
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
          request_id: 'after-cancel',
          text: 'PRESERVED_QUEUE',
          mode: 'follow_up',
        })
      ).disposition,
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
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'released');
  },
);

test('independent extension input is refused without shutdown', { timeout: 15000 }, async (t) => {
  const f = await fixture(
    t,
    `pi.registerCommand('start-external',{handler:async()=>{pi.sendUserMessage('EXTERNAL_HELD');}});
    pi.on('before_agent_start',async event=>{if(event.prompt==='EXTERNAL_HELD'){await mark('external');await wait('external-go');}});`,
  );
  const rpc = await f.bridge.pool.resolve(f.session);
  await rpc.command({ type: 'prompt', message: '/start-external' });
  await until(() => exists(path.join(f.dir, 'external')));
  const old = structuredClone(rpc.ownerRecord);
  await assert.rejects(transfer(f), /RUNTIME_IDLE_UNCONFIRMED/);
  assert.equal(await ownerAlive(old.owner), true);
  assert.equal(rpc.gracefulExitPromise, undefined);
  await f.mark('external-go');
  await until(() => rpc.settlement.sequence === 1);
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
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    const retry = await transfer(f);
    await ownerRequest(f.config, { ...f.request, op: 'handoff_cancel', handoff_id: randomUUID() });
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, retry.generation);
    await cancel(f);
  },
);

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
test('cancel during reservation validation never starts native switching and releases the reservation', async (t) => {
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
      if (record?.phase === 'starting' && record.handoffId) {
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
    await shortcuts['ctrl+alt+j'](ctx);
    release.resolve();
    await joined;
    assert.equal(switches, 0);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'released');
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
    assert.equal(held.phase, 'starting');
    assert.equal(held.owner.pid, process.pid);
    assert.equal(held.noColdReacquire, true);
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
])
  test(`ordinary native TUI joins with latest history (${mode})`, { timeout: 35000 }, async (t) => {
    const laterVeto = mode.startsWith('later'),
      cancelWait = mode.startsWith('cancel');
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('settle');});
    pi.on('session_shutdown',()=>{pi.appendEntry('final-owned-history',{latest:true});});`,
    );
    const other = await savedSession(f.bridge, { folder_id: 'project', request_id: 'other' }),
      sessionB = await f.bridge.session(other.session_id);
    const tuiExtension = path.join(f.dir, 'tui.mjs');
    await fs.writeFile(
      tuiExtension,
      `import fs from 'node:fs/promises';const dir=${JSON.stringify(f.dir)};let veto=${laterVeto};
    export default pi=>{pi.on('session_start',async(event,ctx)=>{if(event.reason==='resume')await fs.writeFile(dir+'/opened.json',JSON.stringify(ctx.sessionManager.getEntries()));});
      pi.on('session_before_switch',async event=>{if(event.targetSessionFile===${JSON.stringify(f.session.file)}&&veto){veto=false;return {cancel:true};}});};`,
    );
    const args = [
      process.execPath,
      path.join(base, 'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),
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
    t.after(async () => {
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
        request_id: command,
        text: `/${command} ${f.id}`,
      });
      assert.equal(denied.status, 'rejected');
      assert.equal(denied.reason, 'OWNER_LOCAL_COMMAND_REQUIRED');
    }
    await f.bridge.send({ session_id: f.id, request_id: 'owned', text: 'NATIVE_JOIN_LATEST' });
    const rpc = f.bridge.pool.get(f.id),
      old = structuredClone(rpc.ownerRecord);
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
    if (laterVeto) {
      await until(() => terminal.includes('Session switch cancelled'), 'later veto');
      await until(async () => {
        const r = await readClaim(f.config.attachmentDir, f.session);
        return r?.phase === 'released';
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
    assert.equal(local.noColdReacquire, true);
    assert.equal(f.bridge.pool.get(f.id), null);
    assert.ok((await f.bridge.read({ session_id: f.id })).items.length > 0);
  });
