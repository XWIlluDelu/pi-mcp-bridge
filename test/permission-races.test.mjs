import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { withdrawalCollector } from '../src/stop-execution.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { executeBatch } from '../src/batch.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { releasedEntries, fixture as nativeFixture } from './fixtures/model-runtime.mjs';
for (const operation of ['send', 'create', 'command'])
  test(
    operation + ' retains admission permissions through slow native identity observation',
    async (t) => {
      const f = await nativeFixture(t),
        { bridge, id } = f;
      f.config.grants[0].command = true;
      await fs.writeFile(f.configFile, JSON.stringify(f.config));
      await bridge.pool.resolve(await bridge.session(id));
      let revoked = false;
      const dispatched = [];
      function intercept(runtime) {
        const dispatch = runtime.dispatch.bind(runtime);
        runtime.dispatch = async (input, ...rest) => {
          if (['prompt', 'bash'].includes(input.type)) dispatched.push(input.type);
          const result = await dispatch(input, ...rest);
          if (input.type === 'get_state' && !revoked) {
            revoked = true;
            await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
          }
          return result;
        };
      }
      if (operation === 'create') {
        const factory = bridge.pool.factory;
        bridge.pool.factory = async (session) => {
          const runtime = await factory(session);
          intercept(runtime);
          return runtime;
        };
      } else intercept(bridge.pool.get(id));
      const args = {
        ...(operation === 'create'
          ? { project: f.cwd, text: 'ADMITTED' }
          : operation === 'send'
            ? { session_id: id, text: 'ADMITTED' }
            : { session_id: id, command: 'printf ADMITTED' }),
      };
      const result = await bridge[operation](args);
      assert.equal(
        result.status,
        operation === 'command' ? 'accepted' : 'started',
        JSON.stringify(result),
      );
      assert.deepEqual(dispatched, [operation === 'command' ? 'bash' : 'prompt']);
      const denied = await callBridgeTool(bridge, operation, { ...args });
      assert.match(JSON.stringify(denied), /NOT_FOUND_OR_DENIED/);
      assert.equal(dispatched.length, 1);
      if (operation === 'create') {
        assert.equal(result.created, true);
        const entries = await releasedEntries(bridge, result.session_id);
        assert.ok(entries.some((e) => e.message?.role === 'user'));
      }
    },
  );
for (const operation of ['command', 'stop'])
  test(
    operation +
      ' retains its permission snapshot through inline output delivery; new calls reauthorize',
    { timeout: 15000 },
    async (t) => {
      const f = await nativeFixture(t),
        { bridge, id } = f,
        marker = 'SYNTHETIC_' + operation.toUpperCase() + '_SECRET ';
      f.config.grants[0].command = true;
      f.config.grants[0].read = false;
      const allowed = structuredClone(f.config);
      await fs.writeFile(f.configFile, JSON.stringify(allowed));
      await bridge.pool.resolve(await bridge.session(id));
      const runtime = bridge.pool.get(id),
        dispatch = runtime.dispatch.bind(runtime);
      let executions = 0;
      t.mock.method(runtime, 'dispatch', (input, ...rest) => {
        if (input.type === (operation === 'command' ? 'bash' : 'abort')) executions++;
        return dispatch(input, ...rest);
      });
      if (operation === 'stop') {
        await bridge.send({ session_id: id, text: 'HOLD_MODEL' });
        await bridge.send({
          session_id: id,

          text: marker.repeat(100),
          mode: 'follow_up',
        });
      }
      const method = operation === 'command' ? 'executeBash' : 'stopExecution',
        native = runtime[method].bind(runtime);
      let blocked;
      t.mock.method(runtime, method, async (...args) => {
        const result = await native(...args);
        if (blocked) {
          const wait = blocked;
          blocked = null;
          wait.entered.resolve();
          await wait.release.promise;
        }
        return result;
      });
      const base = { session_id: id, max_chars: 256 };
      const revokeDuringRead = async (args) => {
        const wait = {
          entered: Promise.withResolvers(),
          release: Promise.withResolvers(),
        };
        blocked = wait;
        const pending = callBridgeTool(bridge, operation, args);
        try {
          await wait.entered.promise;
          const revoked = structuredClone(allowed);
          revoked.grants[0][operation] = false;
          await fs.writeFile(f.configFile, JSON.stringify(revoked));
          wait.release.resolve();
          const response = await pending;
          assert.ok(!response.isError, JSON.stringify(response));
          assert.ok(JSON.stringify(response).includes(marker.trim()));
          const denied = await callBridgeTool(bridge, operation, args);
          assert.equal(denied.isError, true);
          assert.equal(JSON.parse(denied.content[0].text).error.code, 'NOT_FOUND_OR_DENIED');
          assert.ok(!JSON.stringify(denied).includes(marker.trim()));
        } finally {
          wait.release.resolve();
          await pending;
          await fs.writeFile(f.configFile, JSON.stringify(allowed));
        }
      };
      try {
        await revokeDuringRead({
          ...base,
          ...(operation === 'command'
            ? { command: "printf '%s' '" + marker.repeat(100) + "'" }
            : {}),
        });
        assert.equal(executions, 1, 'Permission denial must not execute native work');
      } finally {
        t.mock.restoreAll();
      }
    },
  );

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-permission-race-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    piRuntime: { agentDir: path.join(dir, 'agent'), inheritEnv: [] },
    piArgs: ['--session-dir', path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: {
      ...denyAllPermissions(),
      list: true,
      read: true,
      send: true,
      create: true,
      delete: true,
    },
  };
  const configFile = path.join(dir, 'config.json');
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const calls = [],
    runtime = {
      alive: true,
      state: async () => ({ isIdle: true }),
      command: async (c) => {
        calls.push(c.message);
        return { disposition: 'started' };
      },
      stop: async () => {},
    };
  const bridge = await new Bridge(config, async () => runtime, { configFile }).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const update = async (fn) => {
    const next = JSON.parse(await fs.readFile(configFile, 'utf8'));
    fn(next);
    await fs.writeFile(configFile, JSON.stringify(next));
  };
  return { bridge, cwd, config, runtime, calls, update };
}
test('send retains admission permissions through blocked cold startup', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.bridge.pool.factory = async () => {
    entered.resolve();
    await release.promise;
    return f.runtime;
  };
  const pending = f.bridge.send({
    session_id: seed.session_id,

    text: 'admitted before revocation',
  });
  await entered.promise;
  await f.update((c) => {
    c.defaults.send = false;
  });
  release.resolve();
  assert.ok(
    ['started', 'queued', 'handled'].includes((await pending).status),
    'Expected native prompt admission',
  );
  assert.deepEqual(f.calls, ['admitted before revocation']);
  assert.equal(
    (await f.bridge.send({ session_id: seed.session_id, text: 'denied' })).reason,
    'NOT_FOUND_OR_DENIED',
  );
});
test('list keeps parent references from its snapshot through slow child status', async (t) => {
  const f = await fixture(t),
    parent = await savedSession(f.bridge),
    child = await savedSession(f.bridge);
  const parentSession = await f.bridge.session(parent.session_id),
    childSession = await f.bridge.session(child.session_id);
  await fs.writeFile(
    childSession.file,
    JSON.stringify({ ...childSession.header, parentSession: parentSession.file }) + '\n',
  );
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.runtime.state = async () => {
    entered.resolve();
    await release.promise;
    return { isIdle: true };
  };
  f.bridge.pool.instances.set(child.session_id, f.runtime);
  const pending = f.bridge.list({ session_id: child.session_id });
  await entered.promise;
  await f.update((c) => {
    c.grants = [{ session_id: parent.session_id, list: false }];
  });
  release.resolve();
  const result = await pending;
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].parent_session_id, parent.session_id);
  const fresh = await f.bridge.list({ session_id: child.session_id });
  assert.equal(fresh.sessions[0].parent_session_id, null);
});
test('deleted-file receipt replay requires current authorization without needing the original file', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge),
    args = { session_id: seed.session_id };
  const first = await f.bridge.delete(args);
  assert.equal(first.status, 'deleted');

  await f.update((c) => {
    c.defaults.delete = false;
  });
  const denied = await f.bridge.delete(args);
  assert.equal(denied.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(denied.restore_token, undefined);
  await f.update((c) => {
    c.grants = [{ session_id: seed.session_id, delete: true }];
  });
});
test('create holds the new session lane until its initial prompt is admitted', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const resolve = f.bridge.pool.resolve.bind(f.bridge.pool);
  t.mock.method(f.bridge.pool, 'resolve', async (session) => {
    entered.resolve(session.id);
    await release.promise;
    return resolve(session);
  });
  const creating = f.bridge.create({ project: f.cwd, text: 'initial' }),
    id = await entered.promise;
  const sending = f.bridge.send({ session_id: id, text: 'later' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
  release.resolve();
  assert.ok(
    ['started', 'queued', 'handled'].includes((await creating).status),
    'Expected native prompt admission',
  );
  assert.ok(
    ['started', 'queued', 'handled'].includes((await sending).status),
    'Expected native prompt admission',
  );
  assert.deepEqual(f.calls, ['initial', 'later']);
});
test('stop keeps its admission grant through durable dispatch receipt writes', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge);
  let stops = 0;
  await f.update((c) => {
    c.defaults.stop = true;
  });
  f.runtime.generation = 'native-generation';
  const session = await f.bridge.session(seed.session_id);
  f.runtime.stopExecution = async ({ max_chars }) => {
    stops++;
    const withdrawn = withdrawalCollector(max_chars);
    return {
      status: 'accepted',
      acknowledgement: 'native_ack',
      coverage: 'agent_and_bash',
      withdrawal: withdrawn.add({ steering: ['kept output'], followUp: [] }),
    };
  };
  f.bridge.pool.instances.set(seed.session_id, f.runtime);
  const stop = f.runtime.stopExecution;
  f.runtime.stopExecution = async (args) => {
    const result = await stop(args);
    await f.update((c) => {
      c.defaults.stop = false;
    });
    return result;
  };
  assert.equal(
    (await f.bridge.stop({ session_id: seed.session_id })).withdrawn_text,
    'kept output',
  );
  assert.equal(stops, 1);
  await assert.rejects(f.bridge.stop({ session_id: seed.session_id }), /NOT_FOUND_OR_DENIED/);
});
test('delete retains its admission grant through owner release', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge),
    session = await f.bridge.session(seed.session_id);
  const stop = f.bridge.pool.stopForDelete.bind(f.bridge.pool);
  t.mock.method(f.bridge.pool, 'stopForDelete', async (s) => {
    const release = await stop(s);
    await f.update((c) => {
      c.defaults.delete = false;
    });
    return release;
  });
  const result = await f.bridge.delete({
    session_id: seed.session_id,
  });
  assert.equal(result.status, 'deleted');
  await assert.rejects(fs.stat(session.file), { code: 'ENOENT' });
  assert.equal(
    (await f.bridge.delete({ session_id: seed.session_id })).reason,
    'NOT_FOUND_OR_DENIED',
  );
});
test('prototype property operation names remain invalid individual batch items', async () => {
  let listed = 0;
  const result = await executeBatch(
    {
      list: async () => {
        listed++;
        return { sessions: [] };
      },
    },
    {
      operations: [
        ...['constructor', '__proto__', 'toString'].map((op) => ({ op, args: {} })),
        { op: 'list', args: {} },
      ],
    },
  );
  assert.equal(listed, 1);
  assert.ok(result.results.slice(0, 3).every((item) => item.error.code === 'INVALID_OPERATION'));
});
