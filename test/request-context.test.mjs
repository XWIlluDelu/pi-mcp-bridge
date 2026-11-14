import { append, message } from './fixtures/native-history.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { savedSession } from './fixtures/saved-session.mjs';
import { readClaim, reserveOwner } from '../src/attachments.mjs';

import { callBridgeTool } from '../src/protocol.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';
import { executeBatch } from '../src/batch.mjs';
import { fixture, releasedEntries, until } from './fixtures/model-runtime.mjs';

const gate = () => Promise.withResolvers();
const writePolicy = (f, config) => fs.writeFile(f.configFile, JSON.stringify(config));
function delayExecutor() {
  const entered = gate(),
    release = gate();
  return {
    entered: entered.promise,
    resume: release.resolve,
    async execute(run) {
      entered.resolve();
      await release.promise;
      return run();
    },
  };
}

test('receive-time snapshots precede delayed executors and isolate concurrent deny and allow changes', async (t) => {
  const f = await fixture(t),
    allowed = structuredClone(f.config),
    denied = { ...allowed, grants: [] },
    first = delayExecutor(),
    second = delayExecutor();
  const captures = [];
  const capture = f.bridge.captureRequestContext.bind(f.bridge);
  t.mock.method(f.bridge, 'captureRequestContext', () => {
    const snapshot = capture();
    captures.push(snapshot);
    return snapshot;
  });
  const receive = (text, executor) =>
    callBridgeTool(f.bridge, 'send', { session_id: f.id, text }, executor);
  t.after(() => {
    first.resume();
    second.resume();
  });
  const a = receive('ADMITTED_A', first);
  await first.entered;
  assert.ok(Object.isFrozen((await captures[0]).permissions.grants[0]));
  await writePolicy(f, denied);
  const b = receive('DENIED_B', second);
  await second.entered;
  await captures[1];
  first.resume();
  assert.equal((await a).structuredContent.status, 'started');
  await releasedEntries(f.bridge, f.id);
  await writePolicy(f, allowed);
  assert.equal((await f.bridge.send({ session_id: f.id, text: 'ADMITTED_C' })).status, 'started');
  second.resume();
  assert.equal((await b).structuredContent.reason, 'NOT_FOUND_OR_DENIED');
  const entries = await releasedEntries(f.bridge, f.id);
  assert.equal(entries.filter((e) => e.message?.role === 'user').length, 2);
  assert.deepEqual(
    f.config.grants,
    allowed.grants,
    'Request admission must not mutate shared config',
  );
});

test('pending registry moves preserve reads and live-owner reuse but cannot admit a writer in the old namespace', async (t) => {
  const f = await fixture(t);
  const session = await f.bridge.session(f.id);
  const nextRegistry = path.join(f.dir, 'next-ipc');
  const owned = await f.bridge.pool.resolve(session);
  await writePolicy(f, { ...f.config, attachmentDir: nextRegistry });
  assert.strictEqual(await f.bridge.pool.resolve(session), owned);
  await f.bridge.pool.stop(f.id);
  await reserveOwner(nextRegistry, session, 'tui');
  assert.equal((await f.bridge.read({ session_id: f.id })).session_id, f.id);
  assert.deepEqual((await f.bridge.health()).restart_required, ['attachmentDir']);
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: 'MUST_NOT_SPAWN' })).reason,
    'CONFIG_RESTART_REQUIRED',
  );
  assert.equal(f.bridge.pool.instances.size, 0);
  assert.equal(await readClaim(f.bridge.pool.attachmentDir, session), null);
});

test('policy failure before a delayed executor is handled immediately and never falls back to old config', async (t) => {
  const f = await fixture(t),
    delay = delayExecutor(),
    failed = gate(),
    capture = f.bridge.captureRequestContext.bind(f.bridge);
  t.after(delay.resume);
  t.mock.method(f.bridge, 'captureRequestContext', () =>
    capture().catch((error) => {
      failed.resolve();
      throw error;
    }),
  );
  await fs.writeFile(f.configFile, '{ invalid');
  const pending = callBridgeTool(f.bridge, 'health', {}, delay);
  await delay.entered;
  // Let the policy read reject while the executor has not attached its await yet.
  await failed.promise;
  await new Promise((resolve) => setImmediate(resolve));
  await writePolicy(f, f.config);
  delay.resume();
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

test('one batch snapshot retains permissions and directory scope across late lane items', async (t) => {
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
  await writePolicy(f, {
    ...f.config,
    grants: [],
    folders: [],
    sessionRoots: [path.join(f.dir, 'new-empty-root')],
  });
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
  await until(() => !f.bridge.pool.get(f.id) && !f.bridge.autoReleases.size);
});

test('scope reload applies to cached IDs and cursors while preserving cleanup identity', async (t) => {
  const f = await nativeOwner(t, { reloadConfig: true });
  const { bridge, session, id } = f,
    root = path.join(f.dir, 'added-root');
  await append(
    session,
    Array.from({ length: 4 }, (_, i) =>
      message('m' + i, i ? 'm' + (i - 1) : null, 'user', 'scope-page '.repeat(200)),
    ),
  );
  const page = await bridge.read({
    session_id: id,
    range: { recent: -1 },
    content: ALL_CONTENT,
    max_bytes: 4096,
  });
  assert.ok(page.next_cursor);
  const expanded = { ...f.config, sessionRoots: [...f.config.sessionRoots, root] };
  await writePolicy(f, expanded);
  const context = await bridge.captureRequestContext();
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  const added = await savedSession({ config: { ...expanded, sessionRoots: [root] } });
  assert.equal((await bridge.list()).sessions.length, 2);
  await writePolicy(f, { ...expanded, sessionRoots: [root], folders: [] });
  await assert.rejects(bridge.read({ session_id: id }), /NOT_FOUND_OR_DENIED/);
  await assert.rejects(bridge.read({ cursor: page.next_cursor }), /NOT_FOUND_OR_DENIED/);
  assert.deepEqual(
    (await bridge.list()).sessions.map((row) => row.session_id),
    [added.session_id],
  );
  assert.equal((await bridge.create({ project: f.cwd })).reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(
    (await bridge.read({ cursor: page.next_cursor }, { requestContext: context })).session_id,
    id,
  );
  bridge.pool.instances.set(id, { session, alive: false });
  assert.equal((await bridge.session(id)).file, session.file);
  bridge.pool.instances.delete(id);
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
