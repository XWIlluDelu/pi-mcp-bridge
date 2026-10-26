import { ALL_CONTENT } from '../src/read-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { executeBatch } from '../src/batch.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { readClaim } from '../src/attachments.mjs';
import { dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';
import { ContextObservation } from '../src/context-observation.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error('OBSERVED_TEST_TIMEOUT');
}
async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-observed-'),
    cwd = dir + '/project';
  await fs.mkdir(cwd);
  const transform = dir + '/transform.mjs';
  // Loaded AFTER the owned observer: the phase ordering, not path order,
  // must still expose the transformed request.
  await fs.writeFile(
    transform,
    `import fs from 'node:fs/promises';
    export default pi=>{
      pi.on('context',event=>({messages:[
        {role:'user',content:'TRANSFORMED_SUMMARY_BODY',timestamp:1},
        ...event.messages.filter(m=>!JSON.stringify(m).includes('DROP_FROM_REQUEST'))
      ]}));
      pi.on('before_agent_start',()=>{pi.appendEntry('run-count',{});});
      pi.on('context_with_system',event=>{
        event.messages.push({role:'user',content:'LATER_FULL_CONTEXT_HOOK',timestamp:1});
      });
    };`,
  );
  const config = {
    ...isolatedRuntime(dir),
    stateDir: dir + '/state',
    attachmentDir: dir + '/ipc',
    sessionRoots: [dir + '/sessions'],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [{ folder: cwd, list: true, read: true, send: true }],
  };
  config.piArgs.push(
    '-e',
    path.resolve('test/fixtures/faux-extension.mjs'),
    '-e',
    transform,
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
  bridge.pool.factory = async (s) => {
    const r = await factory(s);
    runtimes.push(r);
    return r;
  };
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const released = () => until(() => runtimes.at(-1)?.exited && !bridge.autoReleases.size);
  return { dir, config, bridge, runtimes, session, id: session.id, released };
}
async function pages(bridge, first) {
  const result = [first];
  while (result.at(-1).next_cursor)
    result.push(await bridge.read({ cursor: result.at(-1).next_cursor, max_bytes: 4096 }));
  return result.flatMap((p) => p.items);
}

test(
  'runtime capture survives no-prompt cold starts and release, then updates on the next prompt',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      read = () => f.bridge.read({ session_id: f.id, view: 'runtime', max_bytes: 4096 });
    assert.equal((await read()).observation.reason, 'no_retained_observation');
    assert.equal(f.runtimes.length, 0);
    await f.bridge.send({ session_id: f.id, text: 'DROP_FROM_REQUEST' });
    await f.released();
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    const before = await fs.readFile(f.session.file, 'utf8');
    const first = await read(),
      units = await pages(f.bridge, first);
    assert.equal(first.source, 'retained');
    assert.equal(first.observation.available, true);
    assert.equal(first.observation.owner_active, false);
    assert.ok(first.observation.later_committed_entries >= 1);
    assert.ok(JSON.stringify(units).includes('TRANSFORMED_SUMMARY_BODY'));
    assert.ok(!JSON.stringify(units).includes('DROP_FROM_REQUEST'));
    assert.ok(!JSON.stringify(units).includes('LATER_FULL_CONTEXT_HOOK'));
    assert.ok(!JSON.stringify(units).includes('Synthetic response 1.'));
    const native = await f.bridge.read({
      session_id: f.id,
      range: { recent: -1 },
      content: ALL_CONTENT,
    });
    assert.equal(native.view, 'session');
    assert.ok(JSON.stringify(native).includes('DROP_FROM_REQUEST'));
    assert.ok(JSON.stringify(native).includes('Synthetic response 1.'));
    assert.equal(await fs.readFile(f.session.file, 'utf8'), before);
    assert.equal(f.runtimes.length, 1);
    const mcp = await dispatchModern(f.bridge, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'read',
        arguments: { session_id: f.id, view: 'runtime', max_bytes: 4096 },
        _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
      },
    });
    assert.equal(mcp.message.result.structuredContent.observation.id, first.observation.id);
    const batch = await executeBatch(f.bridge, {
      operations: [{ op: 'read', args: { session_id: f.id, view: 'runtime', max_bytes: 4096 } }],
    });
    assert.equal(batch.results[0].result.observation.id, first.observation.id);
    f.config.grants[0].read = false;
    await assert.rejects(read(), /NOT_FOUND_OR_DENIED/);
    f.config.grants[0].read = true;
    // Reopening an owner is not a request-stage observation. The saved capture
    // must remain readable while this new owner is idle and after a rejected
    // no-prompt operation releases it again.
    const idleOwner = await f.bridge.pool.resolve(f.session);
    assert.notEqual(idleOwner.ownerRecord.generation, first.observation.owner_generation);
    const whileIdle = await read();
    const current = await f.bridge.read({ session_id: f.id });
    assert.equal(whileIdle.source, 'retained');
    assert.equal(whileIdle.observation.owner_active, false);
    assert.equal(whileIdle.observation.current_leaf_id, current.leaf_id);
    const compact = await f.bridge.compact({ session_id: f.id });
    assert.equal(compact.status, 'rejected');
    await f.released();
    const afterNoPrompt = await read();
    for (const saved of [whileIdle, afterNoPrompt]) {
      assert.equal(saved.observation.available, true);
      for (const key of ['id', 'observed_at', 'owner_generation', 'input_leaf_id'])
        assert.equal(saved.observation[key], first.observation[key], key);
      assert.deepEqual(
        (await pages(f.bridge, saved)).map(({ ref, ...item }) => item),
        units.map(({ ref, ...item }) => item),
      );
    }
    await f.bridge.send({ session_id: f.id, text: 'KEPT_TAIL' });
    await f.released();
    const next = await read();
    assert.notEqual(next.observation.id, first.observation.id);
    assert.notEqual(next.observation.owner_generation, first.observation.owner_generation);
    assert.ok(JSON.stringify(await pages(f.bridge, next)).includes('KEPT_TAIL'));
    assert.equal(f.runtimes.length, 3);
    assert.equal(f.bridge.pool.observations.entries.size, 1);
  },
);

test('an uncaptured live owner validates retained context against its active branch, not the saved tail', async (t) => {
  const f = await fixture(t);
  const entries = [
    { type: 'message', id: 'other', parentId: null, message: { role: 'user', content: 'OTHER' } },
    { type: 'message', id: 'input', parentId: null, message: { role: 'user', content: 'INPUT' } },
    { type: 'message', id: 'tail', parentId: 'input', message: { role: 'assistant', content: [] } },
  ];
  await fs.appendFile(f.session.file, entries.map(JSON.stringify).join('\n') + '\n');
  let leaf = 'input';
  const ctx = {
    sessionManager: {
      getSessionFile: () => f.session.file,
      getSessionId: () => f.session.header.id,
      getLeafId: () => leaf,
      getEntries: () => entries,
    },
  };
  const args = { session_id: f.id, view: 'runtime' };
  const previous = new ContextObservation('previous');
  previous.capture({ messages: [{ role: 'user', content: 'RETAINED_CONTEXT' }] }, ctx);
  f.bridge.pool.observations.put(f.session, previous.read(args, ctx), {});
  const fresh = new ContextObservation('current');
  const runtime = {
    attached: true,
    alive: true,
    record: { kind: 'tui', generation: 'current' },
    read: async (args) => fresh.read(args, ctx),
    async stop() {
      this.alive = false;
    },
  };
  f.bridge.pool.instances.set(f.id, runtime);
  t.mock.method(f.bridge.pool, 'forRead', async () => runtime);
  leaf = 'other';
  const other = await f.bridge.read(args);
  assert.equal(other.observation.available, false);
  assert.equal(other.observation.reason, 'input_branch_changed');
  assert.deepEqual(other.items, []);
  leaf = 'tail';
  const same = await f.bridge.read(args);
  assert.equal(same.source, 'retained');
  assert.equal(same.observation.owner_generation, 'previous');
  assert.equal(same.observation.owner_active, false);
  assert.equal(same.observation.current_leaf_id, 'tail');
  assert.equal(same.observation.later_committed_entries, 1);
  assert.equal(same.items[0].text, 'RETAINED_CONTEXT');
});

const gate = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
for (const change of ['newer_capture', 'failed_capture', 'new_owner']) {
  test(`retained publication cannot regress after an older Bridge.read finishes late (${change})`, async (t) => {
    const f = await fixture(t),
      held = gate(),
      proceed = gate();
    // Exercise real Bridge acquisition, final identity checks and saved reads.
    // Control only the owner capture and the async identity-recheck boundary.
    const ctx = {
      sessionManager: {
        getSessionFile: () => f.session.file,
        getSessionId: () => f.session.header.id,
        getLeafId: () => null,
        getEntries: () => [],
      },
    };
    let arm = false,
      first = true;
    const observer = new ContextObservation('owner-one');
    observer.capture({ messages: [{ role: 'user', content: 'OLDER_REQUEST' }] }, ctx);
    const owner = (observer, generation) => ({
      attached: true,
      alive: true,
      record: { kind: 'tui', generation },
      async read(args) {
        const snapshot = observer.read(args, ctx);
        if (first) {
          first = false;
          arm = true;
        }
        return snapshot;
      },
      async stop() {
        this.alive = false;
      },
    });
    let runtime = owner(observer, 'owner-one');
    f.bridge.pool.instances.set(f.id, runtime);
    t.mock.method(f.bridge.pool, 'forRead', async () => runtime);
    const session = f.bridge.session.bind(f.bridge);
    t.mock.method(f.bridge, 'session', async (id) => {
      const value = await session(id);
      if (arm) {
        arm = false;
        held.resolve();
        await proceed.promise;
      }
      return value;
    });
    const read = () => f.bridge.read({ session_id: f.id, view: 'runtime' });
    const older = read();
    t.after(() => proceed.resolve());
    await held.promise;
    if (change === 'new_owner') {
      const next = new ContextObservation('owner-two');
      next.capture({ messages: [{ role: 'user', content: 'NEWER_REQUEST' }] }, ctx);
      // Even if the old runtime has not reported exit yet, it is not current.
      runtime = owner(next, 'owner-two');
      f.bridge.pool.instances.set(f.id, runtime);
    } else {
      observer.capture(
        {
          messages:
            change === 'failed_capture' ? null : [{ role: 'user', content: 'NEWER_REQUEST' }],
        },
        ctx,
      );
    }
    const newer = await read();
    assert.equal(newer.observation.available, change !== 'failed_capture');
    assert.ok(!JSON.stringify(newer).includes('capture_sequence'));
    proceed.resolve();
    assert.ok(JSON.stringify(await older).includes('OLDER_REQUEST'));
    await runtime.stop();
    f.bridge.pool.instances.delete(f.id);
    runtime = null;
    const retained = await read();
    assert.equal(retained.source, 'retained');
    assert.equal(retained.observation.available, change !== 'failed_capture');
    if (change === 'failed_capture') {
      assert.equal(newer.observation.reason, 'capture_failed');
      assert.equal(retained.observation.reason, 'no_retained_observation');
      assert.deepEqual(retained.items, []);
    } else {
      assert.ok(JSON.stringify(retained.items).includes('NEWER_REQUEST'));
      assert.equal(retained.observation.id, newer.observation.id);
    }
  });
}
