import { nativeOwner, fauxArgs, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { aiEntry } from './fixtures/pi.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { ownerAlive, readClaim, reserveOwner, AttachedRuntime } from '../src/attachments.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
async function fixture(t, source = '') {
  const f = await nativeOwner(t, {
    prefix: 'auto',
    async configure(context) {
      const { dir, config, cleanup } = context;
      config.grants[0].delete = false;
      config.piArgs.push(...fauxArgs, '--thinking', 'off');
      await gatedExtension(
        context,
        source,
        `import { fauxProvider } from ${JSON.stringify(aiEntry)};`,
      );
      cleanup.push(async () => {
        for (const gate of ['finish', 'shutdown-go', 'input-go', 'slash-go'])
          await fs.writeFile(dir + '/' + gate, 'go');
      });
    },
  });
  const runtimes = [],
    launch = f.bridge.pool.factory;
  f.bridge.pool.factory = async (session) => {
    const rpc = await launch(session);
    runtimes.push(rpc);
    return rpc;
  };
  return Object.assign(f, {
    runtimes,
    rows: async () =>
      (await fs.readFile(f.session.file, 'utf8')).trim().split('\n').map(JSON.parse),
  });
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
    await until(() => rpc.settlementSequence > 0);
    await rpc.autoReleaseTask;
    assert.ok(held);
    assert.ok(rpc.hasPendingCommand('prompt'));
    assert.equal(rpc.child.stdin.writableEnded, false);
    receive(...held);
    await released(f, rpc);
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
      await until(() => rpc.settlementSequence > 0);
      await rpc.autoReleaseTask;
      assert.equal(rpc.child.stdin.writableEnded, false);
      identityGo.resolve();
      const result = await running;
      assert.equal(result.status, 'completed');
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

const independentWorkSource =
  'return import(' +
  JSON.stringify(new URL('./fixtures/independent-work.mjs', import.meta.url).href) +
  ').then(module=>module.default(pi));';

test(
  'standalone native bash prevents automatic release and completion wakes it',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
      t,
      `const original=AgentSession.prototype.prompt;let started=false;AgentSession.prototype.prompt=function(...args){if(!started){started=true;const session=this;void wait('native-bash-go').then(()=>session.executeBash('touch '+JSON.stringify(dir+'/native-bash-start')+'; while [ ! -e '+JSON.stringify(dir+'/finish')+' ]; do sleep 0.02; done; printf NATIVE_BASH_DONE'));}return original.apply(this,args);};pi.on('input',()=>({action:'handled'}));`,
    );
    const extension = f.dir + '/fixture.mjs';
    await fs.writeFile(
      extension,
      "import {AgentSession} from '@earendil-works/pi-coding-agent';\n" +
        (await fs.readFile(extension, 'utf8')),
    );
    const rpc = await f.bridge.pool.resolve(f.session),
      seal = AttachedRuntime.prototype.seal;
    let calls = 0;
    t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
      calls++;
      return seal.apply(this, args);
    });
    await rpc.command({ type: 'prompt', message: 'CAPTURE_NATIVE_SESSION' });
    await f.mark('native-bash-go');
    try {
      await until(() => exists(f.dir + '/native-bash-start'));
      assert.equal((await rpc.idleSnapshot()).status, 'busy');
      rpc.autoReleaseWanted = true;
      rpc.onIdleCandidate();
      await rpc.autoReleaseTask;
      assert.equal(calls, 0);
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal(await ownerAlive(rpc.ownerRecord.owner), true);
      await f.mark('finish');
      await released(f, rpc);
      assert.equal(calls, 1);
      assert.ok(JSON.stringify(await f.rows()).includes('NATIVE_BASH_DONE'));
    } finally {
      await f.mark('finish');
    }
  },
);

test(
  'lost seal acknowledgment retains the writer until explicit retry and preserves shutdown records',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(
        t,
        `pi.on('input',async event=>{if(event.text==='MUST_NOT_START')await mark('unexpected-input');return {action:'handled'};});pi.on('session_shutdown',async()=>{pi.appendEntry('seal-cleanup',{saved:true});pi.sendMessage({customType:'seal-record',content:'FINAL_RECORD',display:false});pi.sendUserMessage('MUST_NOT_START');await mark('shutdown');await wait('shutdown-go');});`,
      ),
      rpc = await f.bridge.pool.resolve(f.session),
      seal = AttachedRuntime.prototype.seal;
    let calls = 0;
    t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
      const result = await seal.apply(this, args);
      if (++calls === 1) throw Object.assign(new Error('LOST_SEAL_ACK'), { uncertain: true });
      return result;
    });
    await assert.rejects(f.bridge.releaseForLocal({ session_id: f.id }), /LOST_SEAL_ACK/);
    assert.equal(rpc.exitSeal, 'unknown');
    assert.equal(rpc.gracefulExitPromise, undefined);
    assert.equal(rpc.child.stdin.writableEnded, false);
    assert.equal(rpc.handoffPending, true);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    assert.equal(
      (await new AttachedRuntime(f.config, f.session, rpc.ownerRecord).state()).sealed,
      true,
    );
    const input = await f.bridge.send({ session_id: f.id, text: 'MUST_NOT_START' });
    assert.equal(input.status, 'rejected');
    rpc.autoReleaseWanted = true;
    rpc.onIdleCandidate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(f.bridge.autoReleases.size, 0);
    const retry = f.bridge.releaseForLocal({ session_id: f.id });
    try {
      await until(() => exists(f.dir + '/shutdown'));
      assert.equal(calls, 2);
      assert.equal(rpc.child.stdin.writableEnded, true);
      assert.equal(await ownerAlive(rpc.ownerRecord.owner), true);
      assert.equal(await exists(f.dir + '/unexpected-input'), false);
      await f.mark('shutdown-go');
      assert.equal((await retry).status, 'released');
      const rows = await f.rows();
      assert.ok(rows.some((entry) => entry.customType === 'seal-cleanup'));
      assert.ok(
        rows.some((entry) => entry.type === 'custom_message' && entry.customType === 'seal-record'),
      );
    } finally {
      await f.mark('shutdown-go');
      await retry;
    }
  },
);

test(
  'a read admitted during seal connection setup prevents EOF and finishes normally',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      rpc = await f.bridge.pool.resolve(f.session),
      readReady = Promise.withResolvers(),
      readGo = Promise.withResolvers(),
      command = rpc.command.bind(rpc),
      seal = AttachedRuntime.prototype.seal;
    let reading;
    t.mock.method(rpc, 'command', async (...args) => {
      const result = await command(...args);
      if (args[0].type === 'get_entries') {
        readReady.resolve();
        await readGo.promise;
      }
      return result;
    });
    t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
      reading = rpc.entries();
      await readReady.promise;
      return seal.apply(this, args);
    });
    try {
      await assert.rejects(f.bridge.releaseForLocal({ session_id: f.id }), {
        code: 'RUNTIME_BUSY',
        uncertain: false,
      });
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal(rpc.exitSeal, null);
      readGo.resolve();
      assert.ok(Array.isArray((await reading).entries));
    } finally {
      readGo.resolve();
      await reading;
    }
  },
);

test(
  'busy after an unknown seal preserves the local pause and permits a later explicit retry',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, independentWorkSource),
      rpc = await f.bridge.pool.resolve(f.session),
      seal = AttachedRuntime.prototype.seal;
    await rpc.command({ type: 'prompt', message: 'FIRST' });
    await until(
      async () => rpc.settlementSequence === 1 && (await rpc.idleSnapshot()).status === 'idle',
    );
    let first = true;
    t.mock.method(AttachedRuntime.prototype, 'seal', async function (beforeDispatch) {
      if (first) {
        first = false;
        beforeDispatch();
        // Transport uncertainty includes requests that never reached the child.
        throw Object.assign(new Error('SEAL_DELIVERY_UNKNOWN'), { uncertain: true });
      }
      return seal.call(this, beforeDispatch);
    });
    await assert.rejects(f.bridge.releaseForLocal({ session_id: f.id }), /SEAL_DELIVERY_UNKNOWN/);
    await f.mark('new-run');
    try {
      await until(() => exists(f.dir + '/second-input'));
      await assert.rejects(f.bridge.releaseForLocal({ session_id: f.id }), {
        code: 'RUNTIME_BUSY',
        uncertain: true,
      });
      assert.equal(rpc.exitSeal, 'unknown');
      assert.equal(rpc.handoffPending, true);
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
      await f.mark('input-go');
      await until(() => exists(f.dir + '/second-provider'));
      await f.mark('finish');
      await until(
        async () => rpc.settlementSequence === 2 && (await rpc.idleSnapshot()).status === 'idle',
      );
      assert.equal((await f.bridge.releaseForLocal({ session_id: f.id })).status, 'released');
      assert.ok(JSON.stringify(await f.rows()).includes('SECOND_DONE'));
    } finally {
      await f.mark('input-go');
      await f.mark('finish');
    }
  },
);
