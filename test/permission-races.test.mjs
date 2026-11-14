import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { executeBatch } from '../src/batch.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { releasedEntries, fixture as nativeFixture } from './fixtures/model-runtime.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';
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
        operation === 'command' ? 'completed' : 'started',
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
    runtime = ownedRuntime({
      alive: true,
      state: async () => ({ isIdle: true }),
      command: async (c) => {
        calls.push(c.message);
        return { disposition: 'started' };
      },
      stop: async () => {},
    });
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
