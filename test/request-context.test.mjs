import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { callBridgeTool } from '../src/protocol.mjs';
import { executeBatch } from '../src/batch.mjs';
import { fixture, releasedEntries } from './fixtures/model-runtime.mjs';

const gate = () => Promise.withResolvers();
const writePolicy = (f, config) => fs.writeFile(f.configFile, JSON.stringify(config));

test('receive-time snapshots precede delayed executors and isolate concurrent deny and allow changes', async (t) => {
  const f = await fixture(t),
    allowed = structuredClone(f.config),
    denied = { ...allowed, grants: [] },
    snapshots = [],
    capture = f.bridge.captureRequestContext.bind(f.bridge),
    entered = [gate(), gate()],
    release = [gate(), gate()];
  t.after(() => release.forEach((g) => g.resolve()));
  t.mock.method(f.bridge, 'captureRequestContext', () => {
    const pending = capture();
    snapshots.push(pending);
    return pending;
  });
  const receive = (index, text) =>
    callBridgeTool(
      f.bridge,
      'send',
      { session_id: f.id, text },
      {
        execute: async (run) => {
          entered[index].resolve();
          await release[index].promise;
          return run();
        },
      },
    );
  const a = receive(0, 'ADMITTED_A');
  await entered[0].promise;
  const first = await snapshots[0];
  assert.ok(Object.isFrozen(first.permissions.grants[0]));
  await writePolicy(f, denied);
  const b = receive(1, 'DENIED_B');
  await entered[1].promise;
  await snapshots[1];
  release[0].resolve();
  assert.equal((await a).structuredContent.status, 'started');
  await releasedEntries(f.bridge, f.id);
  await writePolicy(f, allowed);
  const c = await f.bridge.send({ session_id: f.id, text: 'ADMITTED_C' });
  assert.ok(['started', 'queued', 'handled'].includes(c.status), JSON.stringify(c));
  release[1].resolve();
  assert.equal((await b).structuredContent.reason, 'NOT_FOUND_OR_DENIED');
  const entries = await releasedEntries(f.bridge, f.id);
  assert.equal(entries.filter((e) => e.message?.role === 'user').length, 2);
  assert.deepEqual(
    f.config.grants,
    allowed.grants,
    'Request admission must not mutate shared config',
  );
});

test('policy failure before a delayed executor is handled immediately and never falls back to old config', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate(),
    failed = gate(),
    capture = f.bridge.captureRequestContext.bind(f.bridge);
  t.after(() => release.resolve());
  t.mock.method(f.bridge, 'captureRequestContext', () =>
    capture().catch((error) => {
      failed.resolve();
      throw error;
    }),
  );
  await fs.writeFile(f.configFile, '{ invalid');
  const pending = callBridgeTool(
    f.bridge,
    'health',
    {},
    {
      execute: async (run) => {
        entered.resolve();
        await release.promise;
        return run();
      },
    },
  );
  await entered.promise;
  // Let the policy read reject while the executor has not attached its await yet.
  await failed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  await writePolicy(f, f.config);
  release.resolve();
  const result = await pending;
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error.code, 'INVALID_OWNER_CONFIG');
  assert.equal(f.bridge.pool.instances.size, 0);
});

for (const operation of ['send', 'command'])
  test(
    'MCP ' + operation + ' registers its Stop fence before slow policy I/O completes',
    async (t) => {
      const f = await fixture(t);
      f.config.grants[0].command = true;
      await writePolicy(f, f.config);
      await f.bridge.pool.resolve(await f.bridge.session(f.id));
      const entered = gate(),
        release = gate(),
        open = fs.open;
      t.after(() => release.resolve());
      let held = false;
      t.mock.method(fs, 'open', async (file, ...args) => {
        const fd = await open(file, ...args);
        if (file === f.configFile && !held) {
          held = true;
          const read = fd.read.bind(fd);
          fd.read = async (...args) => {
            const result = await read(...args);
            entered.resolve();
            await release.promise;
            return result;
          };
        }
        return fd;
      });
      const pending = callBridgeTool(f.bridge, operation, {
        session_id: f.id,

        ...(operation === 'send' ? { text: 'MUST_NOT_RUN' } : { command: 'printf MUST_NOT_RUN' }),
      });
      await entered.promise;
      assert.equal(f.bridge.inputs.size, 1);
      assert.equal((await f.bridge.stop({ session_id: f.id })).status, 'accepted');
      release.resolve();
      const response = await pending;
      assert.equal(response.structuredContent.reason, 'STOP_IN_PROGRESS', JSON.stringify(response));
      const entries = await f.bridge.pool.get(f.id).entries();
      assert.ok(!JSON.stringify(entries).includes('MUST_NOT_RUN'));
    },
  );

test('one direct batch snapshot covers late lane items, list project filters and health', async (t) => {
  const f = await fixture(t),
    entered = gate(),
    release = gate(),
    read = f.bridge.read.bind(f.bridge),
    capture = f.bridge.captureRequestContext.bind(f.bridge);
  t.after(() => release.resolve());
  let captures = 0;
  t.mock.method(f.bridge, 'captureRequestContext', () => {
    captures++;
    return capture();
  });
  t.mock.method(f.bridge, 'read', async (args, options) => {
    const result = await read(args, options);
    entered.resolve();
    await release.promise;
    return result;
  });
  const batch = executeBatch(f.bridge, {
    operations: [
      { op: 'read', args: { session_id: f.id } },
      { op: 'send', args: { session_id: f.id, text: 'ADMITTED_BATCH' } },
      { op: 'list', args: { session_id: f.id } },
      { op: 'health', args: { session_id: f.id } },
    ],
  });
  await entered.promise;
  await writePolicy(f, { ...f.config, grants: [] });
  release.resolve();
  const result = await batch;
  assert.equal(captures, 1);
  assert.equal(result.results[1].result.status, 'started');
  assert.equal(result.results[2].result.sessions[0].session_id, f.id);
  assert.deepEqual(result.results[2].result.creatable_projects, [f.cwd]);
  const health = JSON.stringify(result.results[3].result);
  assert.match(health, /NO_REMOTE_STOP|MODEL_TOOLS_ARE_SEPARATE/);
  const fresh = await f.bridge.list({ session_id: f.id });
  assert.deepEqual(fresh.sessions, []);
  assert.deepEqual(fresh.creatable_projects, []);
  await releasedEntries(f.bridge, f.id);
});

for (const initialRead of [true, false])
  test(
    initialRead
      ? 'fork keeps source-read and target-create in one receive snapshot'
      : 'fork cannot combine old create with newly granted source read',
    async (t) => {
      const f = await fixture(t),
        allowed = structuredClone(f.config),
        entered = gate(),
        release = gate(),
        capture = f.bridge.captureRequestContext.bind(f.bridge);
      t.after(() => release.resolve());
      await writePolicy(f, {
        ...allowed,
        grants: [{ folder: f.cwd, create: true, read: initialRead }],
      });
      t.mock.method(f.bridge, 'captureRequestContext', async () => {
        const context = await capture();
        entered.resolve();
        await release.promise;
        return context;
      });
      const pending = f.bridge.create({ project: f.cwd, fork_from: f.id, text: 'FORK' });
      await entered.promise;
      await writePolicy(f, { ...allowed, grants: [{ folder: f.cwd, read: true }] });
      release.resolve();
      const result = await pending;
      if (initialRead) {
        assert.equal(result.created, true);
        const entries = await releasedEntries(f.bridge, result.session_id);
        assert.equal(entries.filter((e) => e.message?.role === 'user').length, 1);
      } else {
        assert.equal(result.reason, 'NOT_FOUND_OR_DENIED');
        assert.equal(result.session_id, undefined);
        assert.equal((await f.bridge.sessions()).length, 1);
      }
    },
  );
