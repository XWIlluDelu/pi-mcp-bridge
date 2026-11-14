import { nativeOwner, fauxArgs, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { savedEntries } from './fixtures/saved-session.mjs';
import { append, message, text } from './fixtures/native-history.mjs';

import { ackTimeout } from './fixtures/ack-timeout.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { ownerAlive, readClaim, reserveOwner, AttachedRuntime } from '../src/attachments.mjs';

const exists = (file) => fs.stat(file).catch(() => null);
const shutdownGate =
  "pi.on('session_shutdown', async () => { await mark('shutdown'); await wait('shutdown-go'); pi.appendEntry('shutdown-saved', {}); });";
const settleGate =
  "pi.on('agent_before_settle', async () => { await mark('settling'); await wait('finish'); });";

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
        "import { AgentSession } from '@earendil-works/pi-coding-agent';",
      );

      cleanup.push(() =>
        Promise.all(
          ['finish', 'shutdown-go', 'input-go'].map((gate) => fs.writeFile(dir + '/' + gate, 'go')),
        ),
      );
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
    rows: () => savedEntries(f.bridge, f.id),
    send: (text) => f.bridge.send({ session_id: f.id, text }),
    release: (options) => f.bridge.releaseForLocal({ session_id: f.id, ...options }),
    waitFor: (marker) => until(() => exists(f.dir + '/' + marker), marker),
  });
}
async function released(f, rpc) {
  await until(() => rpc.exited && !f.bridge.autoReleases.size);
  assert.equal(rpc.child.exitCode, 0);
  assert.equal(await readClaim(f.config.attachmentDir, rpc.session), null);
}

for (const policy of ['auto release', 'explicit release', 'reload', 'cancelled reload'])
  test(
    `${policy} seals the idle writer before EOF and preserves its shutdown tail`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, shutdownGate);
      const { bridge, session, id } = f;
      const args = { session_id: id };
      await append(session, [message('saved', null, 'user', [text('SAVED')])]);
      const rpc = await bridge.pool.resolve(session);
      const before = await f.rows();
      const { owner, generation } = rpc.ownerRecord;
      const claim = () => readClaim(f.config.attachmentDir, session);
      const kill = t.mock.method(rpc.child, 'kill');
      const idleSnapshot = rpc.idleSnapshot.bind(rpc);
      let idleConfirmed = false;
      t.mock.method(rpc, 'idleSnapshot', async () => {
        const snapshot = await idleSnapshot();
        idleConfirmed = snapshot.status === 'idle';
        return snapshot;
      });
      const seal = AttachedRuntime.prototype.seal;
      const seals = [];
      t.mock.method(AttachedRuntime.prototype, 'seal', async function (...args) {
        const reply = await seal.apply(this, args);
        if (this.record.generation === generation) {
          seals.push({
            idle: idleConfirmed,
            sealed: reply.sealed,
            eof: rpc.child.stdin.writableEnded,
          });
          if (policy === 'cancelled reload' && reply.sealed)
            bridge.handoffs.get(id).controller.abort();
        }
        return reply;
      });

      let operation;
      if (policy === 'auto release') {
        assert.equal((await f.send('FIRST')).status, 'started');
      } else if (policy === 'explicit release') {
        f.config.grants[0].command = true;
        const entered = Promise.withResolvers(),
          stop = Promise.withResolvers();
        const stopping = bridge.locked('stop:' + id, () => {
          entered.resolve();
          return stop.promise;
        });
        await entered.promise;
        operation = f.release();
        void operation.catch(() => {});
        try {
          const blocked = await Promise.all([
            f.send('NEVER'),
            bridge.command({ ...args, command: 'printf NEVER' }),
            bridge.stop(args),
          ]);
          for (const result of blocked)
            assert.match(result.reason, /^(HANDOFF_PENDING|STOP_IN_PROGRESS)$/);
          await assert.rejects(f.release({ interrupt: true }), /HANDOFF_PENDING/);
          assert.deepEqual(seals, []);
          assert.equal(rpc.child.stdin.writableEnded, false);
        } finally {
          stop.resolve();
          await stopping;
        }
      } else {
        operation = bridge.reload(args);
      }

      await f.waitFor('shutdown');
      assert.deepEqual(seals, [{ idle: true, sealed: true, eof: false }]);
      assert.equal(rpc.child.stdin.writableEnded, true);
      assert.equal(await ownerAlive(owner), true);
      assert.equal((await claim()).generation, generation);
      if (policy === 'auto release') {
        operation = f.send('SECOND');
        await until(() => bridge.inputs.size > 0);
      }
      assert.equal(f.runtimes.length, 1);
      await f.mark('shutdown-go');
      const result = await operation;
      assert.equal(rpc.child.exitCode, 0);
      assert.equal(kill.mock.callCount(), 0);
      assert.equal(await ownerAlive(owner), false);

      if (policy === 'auto release' || policy === 'reload') {
        if (policy === 'auto release') assert.equal(result.status, 'started');
        else
          assert.deepEqual(result, {
            status: 'completed',
            owner_version: packageInfo.version,
            read_compatible: true,
          });
        assert.equal(f.runtimes.length, 2);
        const replacement = f.runtimes[1];
        assert.notEqual(replacement.generation, rpc.generation);
        await released(f, replacement);
      } else {
        assert.equal(f.runtimes.length, 1);
        if (policy === 'explicit release') {
          assert.equal(result.status, 'released');
          assert.equal((await claim()).noColdReacquire, true);
          assert.equal((await f.send('NEVER')).reason, 'COLD_REACQUIRE_BLOCKED');
        } else {
          assert.equal(result.status, 'unknown');
          assert.equal(await claim(), null);
        }
      }
      assert.equal(bridge.handoffs.has(id), false);
      const rows = await f.rows();
      assert.deepEqual(rows.slice(0, before.length), before);
      assert.equal(rows.filter((e) => e.customType === 'shutdown-saved').length, f.runtimes.length);
      assert.deepEqual(
        rows.filter((e) => e.message?.role === 'user').map((e) => e.message.content[0].text),
        policy === 'auto release' ? ['SAVED', 'FIRST', 'SECOND'] : ['SAVED'],
      );
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
    assert.equal((await f.send('SETTLED')).status, 'unknown');
    await until(() => rpc.settlementSequence > 0);
    await rpc.autoReleaseTask;
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
    const f = await fixture(t, settleGate);
    f.config.grants[0].command = true;
    await f.send('PROMPT');
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
    const f = await fixture(t, shutdownGate);
    await f.send('PARENT');
    await f.waitFor('shutdown');
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
    const forking = f.bridge.create(args);
    try {
      await observed.promise;
      assert.equal(f.runtimes.length, 1);
      await f.mark('shutdown-go');
      const result = await forking;
      assert.equal(result.status, 'started', JSON.stringify(result));
      const child = f.runtimes[1];
      await released(f, child);
      assert.equal(parent.exited, true);
      const parentRows = await f.rows(),
        childRows = await savedEntries(f.bridge, child.session.id),
        sourceTail = parentRows.find((entry) => entry.customType === 'shutdown-saved');
      assert.ok(childRows.some((entry) => entry.id === sourceTail.id));
      assert.equal(f.runtimes.length, 2, 'fork and replay never reopen the parent');
    } finally {
      await f.mark('shutdown-go');
      await forking;
    }
  },
);

test(
  'explicit interruption after EOF sends SIGTERM and holds ownership until native cleanup finishes',
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(
      t,
      shutdownGate + "\nprocess.on('SIGTERM', () => void mark('sigterm'));",
    );
    assert.equal((await f.send('CLOSING')).status, 'started');
    const [rpc] = f.runtimes;
    await f.waitFor('shutdown');
    const owner = rpc.ownerRecord.owner;
    assert.equal(rpc.child.stdin.writableEnded, true);
    const kill = t.mock.method(rpc.child, 'kill');
    const releasing = f.release({ interrupt: true });
    void releasing.catch(() => {});
    try {
      await f.waitFor('sigterm');
      assert.equal(await ownerAlive(owner), true);
      assert.deepEqual((await readClaim(f.config.attachmentDir, f.session)).owner, owner);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
    } finally {
      await f.mark('shutdown-go');
    }
    assert.equal((await releasing).status, 'released');
    assert.deepEqual(
      kill.mock.calls.map(({ arguments: [signal] }) => signal),
      ['SIGTERM'],
    );
    assert.equal(await ownerAlive(owner), false);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    assert.ok((await f.rows()).some((entry) => entry.customType === 'shutdown-saved'));
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
      await f.waitFor('native-bash-start');
      assert.equal((await rpc.idleSnapshot()).status, 'busy');
      rpc.autoReleaseWanted = true;
      rpc.onIdleCandidate();
      await rpc.autoReleaseTask;
      assert.equal(calls, 0);
      assert.equal(rpc.child.stdin.writableEnded, false);
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
    await assert.rejects(f.release(), /LOST_SEAL_ACK/);
    assert.equal(rpc.exitSeal, 'unknown');
    assert.equal(rpc.child.stdin.writableEnded, false);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
    assert.equal(
      (await new AttachedRuntime(f.config, f.session, rpc.ownerRecord).state()).sealed,
      true,
    );
    assert.equal((await f.send('MUST_NOT_START')).status, 'rejected');
    rpc.autoReleaseWanted = true;
    rpc.onIdleCandidate();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(f.bridge.autoReleases.size, 0);
    const retry = f.release();
    try {
      await f.waitFor('shutdown');
      assert.equal(rpc.child.stdin.writableEnded, true);
      await assert.rejects(fs.stat(f.dir + '/unexpected-input'), { code: 'ENOENT' });
      await f.mark('shutdown-go');
      assert.equal((await retry).status, 'released');
      assert.match(JSON.stringify(await f.rows()), /seal-cleanup.*seal-record/);
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
      await assert.rejects(f.release(), {
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
    await assert.rejects(f.release(), /SEAL_DELIVERY_UNKNOWN/);
    await f.mark('new-run');
    try {
      await f.waitFor('second-input');
      await assert.rejects(f.release(), {
        code: 'RUNTIME_BUSY',
        uncertain: true,
      });
      assert.equal(rpc.exitSeal, 'unknown');
      assert.equal(rpc.child.stdin.writableEnded, false);
      assert.equal((await readClaim(f.config.attachmentDir, f.session)).noColdReacquire, true);
      await f.mark('input-go');
      await f.waitFor('second-provider');
      await f.mark('finish');
      await until(
        async () => rpc.settlementSequence === 2 && (await rpc.idleSnapshot()).status === 'idle',
      );
      assert.equal((await f.release()).status, 'released');
      assert.ok(JSON.stringify(await f.rows()).includes('SECOND_DONE'));
    } finally {
      await f.mark('input-go');
      await f.mark('finish');
    }
  },
);
