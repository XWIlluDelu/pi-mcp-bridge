import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { executeBatch } from '../src/batch.mjs';
import { createHttpService } from '../src/http-server.mjs';
import { ownerAlive, readClaim, processIdentity, reserveOwner } from '../src/attachments.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { RpcClient } from '@earendil-works/pi-coding-agent';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding } from '../src/host-bindings.mjs';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error('RELEASE_TEST_TIMEOUT');
}
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
async function fixture(t, source = '') {
  const dir = await fs.mkdtemp('/tmp/pi-release-'),
    cwd = dir + '/project';
  await fs.mkdir(cwd);
  const extension = dir + '/fixture.mjs';
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises';const dir=${JSON.stringify(dir)};const delay=ms=>new Promise(r=>setTimeout(r,ms));const mark=name=>fs.writeFile(dir+'/'+name,'yes');async function wait(name){while(!await fs.stat(dir+'/'+name).then(()=>true,()=>false))await delay(10);}export default pi=>{${source}};`,
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
    for (const gate of ['finish', 'shutdown-go']) await fs.writeFile(dir + '/' + gate, 'go');
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

for (const method of ['interrupt', 'stop'])
  test(
    `explicit ${method} reaches a native shutdown hook held after EOF`,
    { timeout: 10000 },
    async (t) => {
      const f = await fixture(
        t,
        `pi.on('session_shutdown',async()=>{await mark('shutdown');await wait('shutdown-go');});`,
      );
      const rpc = await f.bridge.pool.resolve(f.session),
        signals = [],
        kill = rpc.child.kill.bind(rpc.child);
      const exiting = rpc.gracefulExit();
      void exiting.catch(() => {});
      await until(() => exists(f.dir + '/shutdown'));
      assert.equal(rpc.child.stdin.writableEnded, true);
      await assert.rejects(
        reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
        /LIVE_OWNER_UNREACHABLE/,
      );
      rpc.child.kill = (signal) => {
        signals.push(signal);
        return kill(signal);
      };
      if (method === 'interrupt')
        assert.equal(
          (await f.bridge.releaseForLocal({ session_id: f.id, interrupt: true })).status,
          'released',
        );
      else await rpc.stop();
      assert.deepEqual(signals, ['SIGTERM']);
      assert.equal(rpc.exited, true);
      assert.equal(rpc.child.signalCode, 'SIGTERM');
      await assert.rejects(exiting, /RUNTIME_EXIT_ABNORMAL/);
      const claim = await readClaim(f.config.attachmentDir, f.session);
      assert.equal(claim?.noColdReacquire ?? false, method === 'interrupt');
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
      assert.notEqual(f.runtimes[0].session.file, f.runtimes[1].session.file);
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
          'pi.on("session_shutdown",async()=>{await mark("shutdown");await wait("shutdown-go");});',
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
        if (enteredEof) await until(() => exists(f.dir + '/shutdown'));
        else await checking.promise;
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
    'normal EOF exit rechecks observed native work after the final ' + window + ' await',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, independentWorkSource),
        rpc = await f.bridge.pool.resolve(f.session);
      await rpc.command({ type: 'prompt', message: 'FIRST' });
      await until(() => rpc.settlement.sequence === 1);
      const observed = Promise.withResolvers(),
        go = Promise.withResolvers();
      let held = false;
      const name = window === 'ack' ? 'drainAcks' : 'assertProcessIdentity',
        original = rpc[name].bind(rpc);
      t.mock.method(rpc, name, async (...args) => {
        const value = await original(...args);
        if (!held) {
          held = true;
          observed.resolve();
          await go.promise;
        }
        return value;
      });
      const exiting = rpc.gracefulExit();
      void exiting.catch(() => {});
      try {
        await observed.promise;
        await f.mark('new-run');
        await until(
          () =>
            exists(f.dir + '/second-provider') &&
            rpc.settlement.sequence < rpc.requiredSettlementSequence,
        );
        assert.equal((await rpc.state()).isStreaming, true);
        go.resolve();
        await assert.rejects(exiting, /RUNTIME_BUSY/);
        assert.equal(rpc.child.stdin.writableEnded, false);
        assert.equal(await ownerAlive(rpc.ownerRecord.owner), true);
        await f.mark('finish');
        await until(() => rpc.settlement.sequence === rpc.requiredSettlementSequence);
        assert.ok(JSON.stringify(await f.rows()).includes('SECOND_DONE'));
        // Independent extension preflight retains its existing uncertainty fence;
        // observing this run must not authorize discarding some other detached input.
      } finally {
        go.resolve();
        await f.mark('finish');
        await exiting.catch(() => {});
      }
    },
  );

test(
  'noninterrupting owner release withdraws its reservation when observed work starts before EOF',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, independentWorkSource);
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
