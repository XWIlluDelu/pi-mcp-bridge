import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { aiEntry } from './fixtures/pi.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { executeBatch } from '../src/batch.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { META, MODERN_VERSION } from '../src/protocol.mjs';
import { ownerAlive, readClaim, processIdentity, reserveOwner } from '../src/attachments.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { RpcClient } from './fixtures/pi.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding } from '../src/host-bindings.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error('AUTO_RELEASE_TEST_TIMEOUT');
}
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
async function fixture(t, source = '') {
  const dir = await fs.mkdtemp('/tmp/pi-auto-'),
    cwd = dir + '/project';
  await fs.mkdir(cwd);
  const extension = dir + '/fixture.mjs';
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises';import {fauxProvider} from ${JSON.stringify(aiEntry)};const dir=${JSON.stringify(dir)};const delay=ms=>new Promise(r=>setTimeout(r,ms));const mark=name=>fs.writeFile(dir+'/'+name,'yes');async function wait(name){while(!await fs.stat(dir+'/'+name).then(()=>true,()=>false))await delay(10);}export default pi=>{${source}};`,
  );
  const config = {
    ...isolatedRuntime(dir),
    stateDir: dir + '/state',
    attachmentDir: dir + '/ipc',
    sessionRoots: [dir + '/sessions'],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [{ folder: cwd, list: true, read: true, send: true, stop: true, create: true }],
  };
  config.piArgs.push(
    '-e',
    path.resolve('test/fixtures/faux-extension.mjs'),
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
    config.piRuntime.agentDir + '/settings.json',
    JSON.stringify({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const bridge = await new Bridge(config).init(),
    runtimes = [],
    factory = bridge.pool.factory;
  bridge.pool.factory = async (session) => {
    const rpc = await factory(session);
    runtimes.push(rpc);
    return rpc;
  };
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  t.after(async () => {
    for (const gate of ['finish', 'shutdown-go', 'input-go', 'slash-go'])
      await fs.writeFile(dir + '/' + gate, 'go');
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const rows = async () =>
    (await fs.readFile(session.file, 'utf8')).trim().split('\n').map(JSON.parse);
  return {
    dir,
    cwd,
    config,
    bridge,
    runtimes,
    session,
    id: session.id,
    rows,
    mark: (name) => fs.writeFile(dir + '/' + name, 'yes'),
  };
}
async function released(f, rpc) {
  await until(() => rpc.exited && !f.bridge.autoReleases.size);
  assert.equal(rpc.child.exitCode, 0);
  assert.equal(rpc.child.signalCode, null);
  assert.equal(await readClaim(f.config.attachmentDir, rpc.session), null);
}
test(
  'completed send releases only after normal shutdown; the next send reconnects and preserves history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');pi.appendEntry('shutdown-saved',{});});`,
    );
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: 'FIRST' })).status,
      ),
      'Expected native prompt admission',
    );
    const first = f.runtimes[0],
      owner = first.ownerRecord.owner;
    await until(() => exists(f.dir + '/shutdown'));
    assert.equal(await ownerAlive(owner), true);
    let done = false;
    const second = f.bridge.send({ session_id: f.id, text: 'SECOND' }).then((r) => {
      done = true;
      return r;
    });
    await delay(30);
    assert.equal(done, false);
    assert.equal(f.runtimes.length, 1);
    await f.mark('shutdown-go');
    assert.equal((await second).status, 'started');
    const next = f.runtimes[1];
    assert.notEqual(next.child.pid, first.child.pid);
    await released(f, next);
    const rows = await f.rows();
    for (const text of ['FIRST', 'SECOND'])
      assert.equal(
        rows.filter(
          (e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes(text),
        ).length,
        1,
      );
    assert.equal(rows.filter((e) => e.message?.role === 'assistant').length, 2);
    assert.equal(rows.filter((e) => e.customType === 'shutdown-saved').length, 2);
  },
);
test(
  'steering and follow-up queues drain before release; idle_only resumes a later round',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('finish');});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'ONE' });
    const rpc = f.runtimes[0];
    await until(() => exists(f.dir + '/settling'));
    for (const mode of ['steer', 'follow_up'])
      assert.equal((await f.bridge.send({ session_id: f.id, text: mode, mode })).status, 'queued');
    assert.equal(
      (
        await f.bridge.send({
          session_id: f.id,

          text: 'SKIP',
          mode: 'idle_only',
        })
      ).status,
      'skipped',
    );
    assert.equal(rpc.child.stdin.writableEnded, false);
    await f.mark('finish');
    await released(f, rpc);
    for (const text of ['ONE', 'steer', 'follow_up'])
      assert.ok(
        (await f.rows()).some(
          (e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes(text),
        ),
      );
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (
          await f.bridge.send({
            session_id: f.id,

            text: 'IDLE_NEW',
            mode: 'idle_only',
          })
        ).status,
      ),
      'Expected native prompt admission',
    );
    await released(f, f.runtimes[1]);
  },
);
test(
  'create handled by a plain input hook releases without requiring an agent run',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('input',()=>{pi.appendEntry('handled-input',{saved:true});return {action:'handled'};});`,
    );
    const made = await f.bridge.create({
      project: f.cwd,

      text: 'HANDLED',
    });
    assert.equal(made.send.status, 'handled');
    const rpc = f.runtimes[0];
    await released(f, rpc);
    assert.equal(rpc.settlement.sequence, 0);
    const rows = (await fs.readFile(rpc.session.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(rows.some((e) => e.customType === 'handled-input'));
  },
);
test(
  'unknown preflight retains ownership until its matching late ACK and run settle',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('input',async()=>{await mark('input-held');await wait('input-go');return {action:'continue'};});`,
    );
    ackTimeout(t, ['prompt']);
    const first = await f.bridge.send({
      session_id: f.id,

      text: 'LATE',
    });
    assert.equal(first.status, 'unknown');
    const rpc = f.runtimes[0];
    assert.ok(rpc.promptAdmission);
    assert.equal(rpc.child.stdin.writableEnded, false);
    await f.mark('input-go');
    await released(f, rpc);
    assert.equal(f.runtimes.length, 1);
  },
);
for (const slash of [false, true])
  test(
    `handled ${slash ? 'slash' : 'input'} waits for a nested native command and then releases`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        `
    pi.registerCommand('inner',{handler:async()=>{await mark('slash-held');await wait('slash-go');await mark('slash-finished');}});
    ${
      slash
        ? "pi.registerCommand('outer',{handler:async()=>pi.sendUserMessage('/inner',{expandPromptTemplates:true})});"
        : "pi.on('input',()=>{pi.sendUserMessage('/inner',{expandPromptTemplates:true});return {action:'handled'};});"
    }
    pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
      );
      assert.equal(
        (await f.bridge.send({ session_id: f.id, text: slash ? '/outer' : 'HANDLED' })).status,
        'handled',
      );
      const rpc = f.runtimes[0];
      await until(() => exists(f.dir + '/slash-held'));
      assert.equal((await rpc.idleSnapshot()).status, 'busy');
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal(await exists(f.dir + '/shutdown'), false);
      await f.mark('slash-go');
      await until(() => exists(f.dir + '/shutdown'));
      assert.equal(await exists(f.dir + '/slash-finished'), true);
      await f.mark('shutdown-go');
      await released(f, rpc);
    },
  );
test(
  'read waits for automatic EOF and then remains saved without reopening a writer',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'READ_AFTER' });
    await until(() => exists(f.dir + '/shutdown'));
    const reading = f.bridge.read({ session_id: f.id });
    await f.mark('shutdown-go');
    assert.ok((await reading).items.some((i) => i.type === 'text'));
    assert.equal(f.runtimes.length, 1);
    assert.equal(f.bridge.pool.get(f.id), null);
    await f.bridge.read({ session_id: f.id });
    assert.equal(f.runtimes.length, 1);
  },
);
test(
  'a cancelled run finishes stop recovery before automatic release',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('finish');});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'CANCEL' });
    const rpc = f.runtimes[0];
    const stopping = f.bridge.stop({ session_id: f.id });
    await f.mark('finish');
    assert.equal((await stopping).status, 'accepted');
    await released(f, rpc);
    assert.equal((await f.bridge.stop({ session_id: f.id })).status, 'skipped');
  },
);
test(
  'an attached host remains registered after a handled prompt',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t);
    const controller = await reserveHostSession({
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    });
    let closed = 0;
    const state = () => ({
      sessionFile: f.session.file,
      sessionId: f.session.header.id,
      isIdle: true,
    });
    await controller.ready({
      state,
      snapshot: () => ({ ...state(), entries: [], leafId: null }),
      submit: async () => ({ status: 'accepted', disposition: 'handled' }),
      release: async () => {
        closed++;
        return { released: true };
      },
    });
    t.after(() => controller.close());
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: 'HOST' })).status,
      ),
      'Expected native prompt admission',
    );
    assert.equal(closed, 0);
    assert.equal(f.runtimes.length, 0);
    await f.bridge.close();
    assert.equal(closed, 0);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'ready');
  },
);

test(
  'settlement cannot release a prompt whose matching ACK is still missing',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const rpc = await f.bridge.pool.resolve(f.session),
      receive = rpc.receiveResponse.bind(rpc);
    let held;
    t.mock.method(rpc, 'receiveResponse', (event, generation) => {
      if (event.type === 'response' && event.command === 'prompt') {
        held = [event, generation];
        return;
      }
      return receive(event, generation);
    });
    ackTimeout(t, ['prompt']);
    const receipt = await f.bridge.send({
      session_id: f.id,

      text: 'SETTLED',
    });
    assert.equal(receipt.status, 'unknown');
    await until(() => rpc.settlement.sequence > 0);
    await rpc.autoReleaseTask;
    assert.ok(held);
    assert.ok(rpc.promptAdmission);
    assert.equal(rpc.child.stdin.writableEnded, false);
    receive(...held);
    await released(f, rpc);
  },
);

test(
  'failed native provider run is saved and normally released after create',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `const faux=fauxProvider({provider:'bridge-fixture',models:[{id:'deterministic'}]});faux.setResponses([()=>{throw new Error('FIXTURE_PROVIDER_FAILURE');}]);pi.registerProvider(faux.provider);`,
    );
    const made = await f.bridge.create({
      project: f.cwd,

      text: 'FAIL',
    });
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    const rpc = f.runtimes[0];
    await released(f, rpc);
    const rows = (await fs.readFile(rpc.session.file, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(
      rows.some((e) => e.message?.role === 'assistant' && e.message.stopReason === 'error'),
    );
    assert.equal(rows.filter((e) => e.message?.role === 'user').length, 1);
  },
);

test(
  'stop during automatic EOF cancels input waiting behind it without dispatching into shutdown',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'FINISHED' });
    await until(() => exists(f.dir + '/shutdown'));
    const rpc = f.runtimes[0];
    const queued = f.bridge.send({
      session_id: f.id,

      text: 'MUST_NOT_START',
    });
    await until(() => f.bridge.inputs.size === 1);
    const stopped = await f.bridge.stop({ session_id: f.id });
    assert.equal(stopped.status, 'skipped');
    assert.equal(stopped.reason, 'not_running');
    await f.mark('shutdown-go');
    const cancelled = await queued;
    assert.equal(cancelled.status, 'rejected');
    assert.equal(cancelled.reason, 'STOP_IN_PROGRESS');
    await released(f, rpc);
    assert.equal(f.runtimes.length, 1);
    assert.ok(
      !(await f.rows()).some(
        (e) =>
          e.message?.role === 'user' &&
          JSON.stringify(e.message.content).includes('MUST_NOT_START'),
      ),
    );
  },
);

test(
  'model catalog queries do not wait for session shutdown or start a writer',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'DONE' });
    await until(() => exists(f.dir + '/shutdown'));
    const page = await f.bridge.models({});
    assert.deepEqual(Object.keys(page).sort(), ['models', 'next_offset']);
    await f.mark('shutdown-go');
    await released(f, f.runtimes[0]);
    assert.equal(f.runtimes.length, 1);
    assert.equal((await f.bridge.list({})).sessions[0].status.state, 'saved');
    assert.equal(f.runtimes.length, 1);
  },
);

test(
  'an existing native RPC host keeps its process and pipes after Bridge prompt completion',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_start',()=>fs.writeFile(dir+'/native-pid',String(process.pid)));`,
    );
    const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    Object.assign(env, {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir,
    });
    const client = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
      env,
      args: ['--session', f.session.file, ...f.config.piArgs],
    });
    const controller = await reserveHostSession({
      attachmentDir: f.config.attachmentDir,
      session: f.session,
    });
    try {
      await client.start();
      await client.getState();
      const owner = await processIdentity(Number(await fs.readFile(f.dir + '/native-pid', 'utf8')));
      await controller.ready(createRpcHostBinding(client), { owner });
      assert.ok(
        ['started', 'queued', 'handled'].includes(
          (await f.bridge.send({ session_id: f.id, text: 'EXTERNAL' })).status,
        ),
        'Expected native prompt admission',
      );
      await until(async () => !(await client.getState()).isStreaming);
      assert.equal(f.runtimes.length, 0);
      assert.equal(f.bridge.autoReleases.size, 0);
      assert.equal(await ownerAlive(owner), true);
      await f.bridge.close();
      assert.equal((await client.getState()).sessionId, f.session.header.id);
      assert.equal(await ownerAlive(owner), true);
    } finally {
      await client.stop();
      await controller.close();
    }
  },
);

test(
  'on-time native bash keeps ownership through identity validation and inline result delivery',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('agent_before_settle',async()=>{await mark('settling');await wait('finish');});`,
    );
    f.config.grants[0].command = true;
    await f.bridge.send({ session_id: f.id, text: 'PROMPT' });
    const rpc = f.runtimes[0],
      dispatch = rpc.dispatch.bind(rpc),
      checking = Promise.withResolvers(),
      identityGo = Promise.withResolvers();
    let bashReturned = false,
      held = false;
    t.mock.method(rpc, 'dispatch', async (command, ...args) => {
      if (command.type === 'get_state' && bashReturned && !held) {
        held = true;
        checking.resolve();
        await identityGo.promise;
      }
      const result = await dispatch(command, ...args);
      if (command.type === 'bash') bashReturned = true;
      return result;
    });
    try {
      const args = { session_id: f.id },
        running = f.bridge.command({ ...args, command: 'printf "NATIVE_OUTPUT"' });
      await checking.promise;
      await f.mark('finish');
      await until(() => rpc.settlement.sequence > 0);
      await rpc.autoReleaseTask;
      assert.equal(rpc.child.stdin.writableEnded, false);
      identityGo.resolve();
      const result = await running;
      assert.equal(result.status, 'accepted');
      assert.equal(result.output, 'NATIVE_OUTPUT');
      await released(f, rpc);
      assert.equal(f.runtimes.length, 1, 'output recovery never reruns or cold-starts the command');
    } finally {
      identityGo.resolve();
    }
  },
);

test(
  'fork during automatic EOF waits for the final native tail without reopening the parent',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');pi.appendEntry('shutdown-saved',{saved:true});});`,
    );
    await f.bridge.send({ session_id: f.id, text: 'PARENT' });
    await until(() => exists(f.dir + '/shutdown'));
    const parent = f.runtimes[0],
      args = { project: f.cwd, fork_from: f.id, text: 'CHILD' };
    const observed = Promise.withResolvers(),
      forRead = f.bridge.pool.forRead.bind(f.bridge.pool);
    t.mock.method(f.bridge.pool, 'forRead', async (session) => {
      const runtime = await forRead(session);
      if (session.id === f.id && f.bridge.handoffs.get(f.id)?.runtime === runtime)
        observed.resolve();
      return runtime;
    });
    let completed = false;
    const forking = f.bridge.create(args).then((result) => {
      completed = true;
      return result;
    });
    try {
      await observed.promise;
      assert.equal(completed, false);
      assert.equal(f.runtimes.length, 1);
      assert.equal(await ownerAlive(parent.ownerRecord.owner), true);
      await f.mark('shutdown-go');
      const result = await forking;
      assert.equal(result.status, 'started', JSON.stringify(result));
      assert.equal(result.created, true);
      const child = f.runtimes[1];
      assert.notEqual(child.session.header.id, parent.session.header.id);
      await released(f, child);
      assert.equal(parent.exited, true);
      const parentRows = await f.rows(),
        childRows = (await fs.readFile(child.session.file, 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse),
        sourceTail = parentRows.find((entry) => entry.customType === 'shutdown-saved');
      assert.ok(sourceTail);
      assert.ok(childRows.some((entry) => entry.id === sourceTail.id));
      assert.equal(parentRows.filter((entry) => entry.message?.role === 'user').length, 1);
      assert.equal(childRows.filter((entry) => entry.message?.role === 'user').length, 2);

      assert.equal(f.runtimes.length, 2, 'fork and replay never reopen the parent');
    } finally {
      await f.mark('shutdown-go');
      await forking;
    }
  },
);

for (const method of ['interrupt', 'stop', 'delete'])
  test(
    `explicit ${method} reaches a native shutdown hook held after EOF`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
      );
      await f.bridge.send({ session_id: f.id, text: 'CLOSING' });
      const rpc = f.runtimes[0],
        signals = [],
        kill = rpc.child.kill.bind(rpc.child);
      await until(() => exists(f.dir + '/shutdown'));
      assert.equal(rpc.child.stdin.writableEnded, true);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      if (method !== 'delete')
        rpc.child.kill = (signal) => {
          signals.push(signal);
          return kill(signal);
        };
      if (method === 'interrupt')
        assert.equal(
          (await f.bridge.releaseForLocal({ session_id: f.id, interrupt: true })).status,
          'released',
        );
      else if (method === 'delete') {
        assert.equal((await f.bridge.delete({ session_id: f.id })).reason, 'NOT_FOUND_OR_DENIED');
        assert.equal(await ownerAlive(rpc.ownerRecord.owner), true);
        const queued = f.bridge.send({ session_id: f.id, text: 'NEVER_RESTART_DURING_DELETE' });
        f.config.grants[0].delete = true;
        const deleted = await f.bridge.delete({ session_id: f.id });
        assert.equal((await queued).status, 'rejected');
        assert.equal(f.runtimes.length, 1);
        assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
        const manifest = JSON.parse(
          await fs.readFile(
            path.join(f.config.stateDir, 'trash', deleted.restore_token + '.restore.json'),
            'utf8',
          ),
        );
        assert.ok(await fs.stat(manifest.trash_path));
        await assert.rejects(fs.stat(f.session.file), { code: 'ENOENT' });
      } else await rpc.stop();
      if (method !== 'delete') {
        assert.deepEqual(signals, ['SIGTERM']);
        assert.equal(rpc.child.signalCode, 'SIGTERM');
      }
      assert.equal(rpc.exited, true);
      assert.equal(await ownerAlive(rpc.childIdentity), false);
      await rpc.autoReleaseTask;
      const claim = await readClaim(f.config.attachmentDir, f.session);
      assert.equal(claim?.noColdReacquire ?? false, method === 'interrupt');
    },
  );

for (const slow of [false, true])
  test(
    `cold command auto-releases after native bash completion (${slow ? 'late ACK' : 'normal'})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        slow
          ? `pi.on('user_bash',async()=>{await mark('bash-held');await wait('finish');return {result:{output:'late-ok',exitCode:0,cancelled:false,truncated:false}};});`
          : '',
      );
      f.config.grants[0].command = true;
      if (slow) ackTimeout(t, ['bash']);
      const result = await f.bridge.command({
        session_id: f.id,
        command: 'printf audit-ok',
      });
      const rpc = f.runtimes[0];
      if (slow) {
        assert.equal(result.status, 'unknown');
        assert.equal(rpc.child.stdin.writableEnded, false);
        assert.equal((await f.bridge.list({ session_id: f.id })).sessions[0].status.state, 'busy');
        await f.mark('finish');
      } else {
        assert.equal(result.status, 'accepted');
        assert.equal(result.output, 'audit-ok');
      }
      await released(f, rpc);
    },
  );

for (const batch of [false, true])
  test(
    `independent same-project creates progress before the first prompt ACK (${batch ? 'batch' : 'direct'})`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        `pi.on('input',async event=>{await mark(event.text+'-entered');if(event.text==='FIRST')await wait('finish');return {action:'handled'};});`,
      );
      const args = (text) => ({ project: f.cwd, text });
      let first, second, results;
      if (batch)
        results = executeBatch(f.bridge, {
          operations: [
            { op: 'create', args: args('FIRST') },
            { op: 'create', args: args('SECOND') },
          ],
        });
      else first = f.bridge.create(args('FIRST'));
      await until(() => exists(f.dir + '/FIRST-entered'));
      if (!batch) second = f.bridge.create(args('SECOND'));
      await until(() => exists(f.dir + '/SECOND-entered'));
      if (!batch) assert.equal((await second).status, 'handled');
      await f.mark('finish');
      const made = batch
        ? (await results).results.map((item) => item.result)
        : [await first, await second];
      assert.equal(new Set(made.map((item) => item.session_id)).size, 2);
      assert.ok(made.every((item) => item.created && item.status === 'handled'));
      await until(() => f.runtimes.every((rpc) => rpc.exited) && !f.bridge.autoReleases.size);
      assert.notEqual(f.runtimes[0].session.file, f.runtimes[1].session.file);
    },
  );

test(
  'a command arriving during automatic EOF waits for exact exit and starts only its own next writer',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
    );
    f.config.grants[0].command = true;
    assert.equal(
      (await f.bridge.command({ session_id: f.id, command: 'printf FIRST' })).output,
      'FIRST',
    );
    await until(() => exists(f.dir + '/shutdown'));
    const first = f.runtimes[0];
    const next = f.bridge.command({ session_id: f.id, command: 'printf SECOND' });
    await f.mark('shutdown-go');
    assert.equal((await next).output, 'SECOND');
    assert.equal(first.exited, true);
    assert.notEqual(f.runtimes[1].child.pid, first.child.pid);
    await released(f, f.runtimes[1]);
  },
);

for (const route of ['direct', 'http'])
  test(
    'shutdown settles input queued behind automatic EOF without a replacement writer (' +
      route +
      ')',
    { timeout: 20000 },
    async (t) => {
      const f = await fixture(
        t,
        `pi.on('input',()=>({action:'handled'}));pi.on('session_shutdown',async()=>{if(!await fs.stat(dir+'/shutdown').then(()=>true,()=>false)){await mark('shutdown');await wait('shutdown-go');}});`,
      );
      assert.equal((await f.bridge.send({ session_id: f.id, text: 'FIRST' })).status, 'handled');
      await until(() => exists(f.dir + '/shutdown'));
      const token = 'a'.repeat(40),
        service = route === 'http' ? createHttpService(f.bridge, { token }) : null,
        previous = f.bridge.locks.get(f.id);
      t.after(() => service?.close());
      let input;
      if (service) {
        const url = await service.listen();
        input = fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            [TOKEN_HEADER]: token,
            'mcp-protocol-version': MODERN_VERSION,
            'Mcp-Method': 'tools/call',
            'Mcp-Name': 'send',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
              name: 'send',
              arguments: { session_id: f.id, text: 'SECOND' },
              _meta: {
                [META + 'protocolVersion']: MODERN_VERSION,
                [META + 'clientCapabilities']: {},
              },
            },
          }),
        }).then((r) => r.json());
      } else input = f.bridge.send({ session_id: f.id, text: 'SECOND' });
      void input.catch(() => {});
      await until(() => f.bridge.inputs.size === 1 && f.bridge.locks.get(f.id) !== previous);
      let complete = false;
      const close = (service ? service.close() : f.bridge.close()).then(() => (complete = true));
      try {
        await until(() => complete);
        const result = await input;
        assert.equal(service ? result.result.structuredContent.status : result.status, 'rejected');
        assert.equal(f.runtimes.length, 1);
        assert.ok(f.runtimes.every((runtime) => runtime.exited));
        assert.equal(f.runtimes[0].child.signalCode, 'SIGTERM');
        assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
      } finally {
        await f.mark('shutdown-go');
        await close;
        await input;
      }
    },
  );

for (const route of ['direct', 'http'])
  for (const enteredEof of [true, false])
    test(
      'closing drains accepted owner-local release ' +
        route +
        ' ' +
        (enteredEof ? 'during EOF' : 'during exit identity check'),
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(
          t,
          'pi.on("input",()=>({action:"handled"}));pi.on("session_shutdown",async()=>{await mark("shutdown");await wait("shutdown-go");});',
        );
        const runtime = await f.bridge.pool.resolve(f.session),
          owner = runtime.ownerRecord.owner,
          signals = [];
        const checking = Promise.withResolvers(),
          go = Promise.withResolvers();
        if (!enteredEof) {
          const check = runtime.assertProcessIdentity.bind(runtime);
          let paused = false;
          t.mock.method(runtime, 'assertProcessIdentity', async (...args) => {
            if (!paused) {
              paused = true;
              checking.resolve();
              await go.promise;
            }
            return check(...args);
          });
        }
        const kill = runtime.child.kill.bind(runtime.child);
        t.mock.method(runtime.child, 'kill', (signal) => {
          signals.push(signal);
          return kill(signal);
        });
        const service =
          route === 'http' ? createHttpService(f.bridge, { token: 'a'.repeat(40) }) : null;
        if (service) {
          await service.listen();
          t.after(() => service.close());
        }
        await f.bridge.send({ session_id: f.id, text: 'START' });
        if (enteredEof) await until(() => exists(f.dir + '/shutdown'));
        else await checking.promise;
        const admitted = Promise.withResolvers(),
          release = f.bridge.releaseForLocal.bind(f.bridge);
        t.mock.method(f.bridge, 'releaseForLocal', (...args) => {
          admitted.resolve();
          return release(...args);
        });
        const releasing = ownerRequest(f.config, { op: 'release', session_id: f.id }).catch(
          (error) => ({ error: error.message }),
        );
        await admitted.promise;
        assert.equal(await ownerAlive(owner), true);
        let complete = false;
        const closing = (service ? service.close() : f.bridge.close()).then(() => {
          complete = true;
        });
        void closing.catch(() => {});
        try {
          await until(() => f.bridge.pool.closing);
          go.resolve();
          await until(() => complete);
          await closing;
          await releasing;
          assert.equal(await ownerAlive(owner), false);
          assert.equal(runtime.exited, true);
          assert.deepEqual(signals, ['SIGTERM']);
          assert.equal(f.runtimes.length, 1);
          assert.equal((await readClaim(f.config.attachmentDir, f.session))?.owner ?? null, null);
        } finally {
          go.resolve();
          await f.mark('shutdown-go');
          await closing;
          await releasing;
        }
      },
    );

const independentWorkSource =
  'return import(' +
  JSON.stringify(new URL('./fixtures/independent-work.mjs', import.meta.url).href) +
  ').then(module=>module.default(pi));';
for (const window of ['ack', 'identity'])
  test(
    'normal release rechecks native input preflight after the final ' + window + ' await',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, independentWorkSource),
        rpc = await f.bridge.pool.resolve(f.session);
      const observed = Promise.withResolvers(),
        go = Promise.withResolvers();
      const idleSnapshot = rpc.idleSnapshot.bind(rpc);
      let idle = false,
        held = false;
      t.mock.method(rpc, 'idleSnapshot', async () => {
        const value = await idleSnapshot();
        if (value.status === 'idle') idle = true;
        return value;
      });
      const name = window === 'ack' ? 'drainAcks' : 'assertProcessIdentity',
        original = rpc[name].bind(rpc);
      t.mock.method(rpc, name, async (...args) => {
        const value = await original(...args);
        if (idle && !held) {
          held = true;
          observed.resolve();
          await go.promise;
        }
        return value;
      });
      try {
        await f.bridge.send({ session_id: f.id, text: 'FIRST' });
        await observed.promise;
        await f.mark('new-run');
        await until(async () => (await exists(f.dir + '/second-input')) && rpc.pendingInputs > 0);
        assert.equal((await rpc.state()).isStreaming, false);
        go.resolve();
        await until(() => !f.bridge.autoReleases.size);
        assert.equal(rpc.child.stdin.writableEnded, false);
        assert.equal(f.bridge.handoffs.has(f.id), false);
        assert.equal(await ownerAlive(rpc.ownerRecord.owner), true);
        await f.mark('input-go');
        await until(() => exists(f.dir + '/second-provider'));
        await f.mark('finish');
        await until(() => rpc.settlement.sequence === rpc.requiredSettlementSequence);
        assert.ok(JSON.stringify(await f.rows()).includes('SECOND_DONE'));
        await released(f, rpc);
      } finally {
        go.resolve();
        await f.mark('input-go');
        await f.mark('finish');
      }
    },
  );

test(
  'noninterrupting owner release withdraws its reservation when observed work starts before EOF',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, independentWorkSource);
    await f.mark('input-go'); // This case observes the later native run boundary.
    const rpc = await f.bridge.pool.resolve(f.session);
    await rpc.command({ type: 'prompt', message: 'FIRST' });
    await until(() => rpc.settlement.sequence === 1);
    const reached = Promise.withResolvers(),
      go = Promise.withResolvers(),
      identity = rpc.assertProcessIdentity.bind(rpc);
    let held = false;
    t.mock.method(rpc, 'assertProcessIdentity', async (...args) => {
      await identity(...args);
      if (!held) {
        held = true;
        reached.resolve();
        await go.promise;
      }
    });
    const releasing = ownerRequest(f.config, { op: 'release', session_id: f.id });
    void releasing.catch(() => {});
    try {
      await reached.promise;
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
      await f.mark('new-run');
      await until(
        () =>
          exists(f.dir + '/second-provider') &&
          rpc.settlement.sequence < rpc.requiredSettlementSequence,
      );
      go.resolve();
      await assert.rejects(releasing, /RUNTIME_BUSY/);
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal(f.bridge.handoffs.has(f.id), false);
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, false);
      await f.mark('finish');
      await until(() => rpc.settlement.sequence === rpc.requiredSettlementSequence);
      assert.ok(JSON.stringify(await f.rows()).includes('SECOND_DONE'));
    } finally {
      go.resolve();
      await f.mark('finish');
      await releasing.catch(() => {});
    }
  },
);
