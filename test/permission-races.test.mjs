import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { executeBatch } from '../src/batch.mjs';
import { fixture as nativeFixture } from './fixtures/model-runtime.mjs';
for (const operation of ['send', 'create', 'command'])
  test(
    operation + ' reauthorizes at native dispatch after a slow identity observation',
    async (t) => {
      const f = await nativeFixture(t),
        { bridge, id } = f;
      f.config.grants[0].command = true;
      await fs.writeFile(f.configFile, JSON.stringify(f.config));
      await bridge.models({ session_id: id, start: true });
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
        request_id: 'dispatch-revoke',
        ...(operation === 'create'
          ? { project: f.cwd, text: 'NEVER' }
          : operation === 'send'
            ? { session_id: id, text: 'NEVER' }
            : { session_id: id, command: 'printf NEVER' }),
      };
      let result;
      if (operation === 'command') {
        await assert.rejects(bridge.command(args), /NOT_FOUND_OR_DENIED/);
        result = (await bridge.journal.get(args.request_id)).receipt;
      } else result = await bridge[operation](args);
      assert.equal(result.status, 'rejected');
      assert.equal((result.send ?? result).reason, 'NOT_FOUND_OR_DENIED');
      assert.deepEqual(dispatched, []);
      if (operation === 'create') {
        assert.equal(result.created, true);
        assert.equal(
          (await bridge.pool.get(result.session_id).entries()).entries.some(
            (e) => e.message?.role === 'user',
          ),
          false,
        );
      }
    },
  );
async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-permission-race-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    principal: 'test',
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'p', path: cwd }],
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
test('send reauthorizes after a blocked cold-start before native dispatch', async (t) => {
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
    request_id: 'revoke',
    text: 'must not dispatch',
  });
  await entered.promise;
  await f.update((c) => {
    c.defaults.send = false;
  });
  release.resolve();
  assert.equal((await pending).reason, 'NOT_FOUND_OR_DENIED');
  assert.deepEqual(f.calls, []);
});
test('list rechecks a parent reference after a slow child status observation', async (t) => {
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
  assert.equal(result.sessions[0].parent_session_id, null);
});
test('deleted-file receipt replay requires current authorization without needing the original file', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge),
    args = { session_id: seed.session_id, request_id: 'delete' };
  const first = await f.bridge.delete(args);
  assert.equal(first.status, 'deleted');
  assert.deepEqual(await f.bridge.delete(args), first);
  await f.update((c) => {
    c.defaults.delete = false;
  });
  const denied = await f.bridge.delete(args);
  assert.equal(denied.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(denied.restore_token, undefined);
  await f.update((c) => {
    c.grants = [{ session_id: seed.session_id, delete: true }];
  });
  assert.deepEqual(await f.bridge.delete(args), first);
});
test('create holds the new session lane until its initial prompt is admitted', async (t) => {
  const f = await fixture(t),
    entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const put = f.bridge.journal.put.bind(f.bridge.journal);
  t.mock.method(f.bridge.journal, 'put', async (id, value) => {
    if (id === 'create' && value.receipt.send?.phase === 'starting') {
      entered.resolve(value.receipt.session_id);
      await release.promise;
    }
    return put(id, value);
  });
  const creating = f.bridge.create({ project: f.cwd, text: 'initial', request_id: 'create' }),
    id = await entered.promise;
  const sending = f.bridge.send({ session_id: id, text: 'later', request_id: 'send' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.calls, []);
  release.resolve();
  assert.equal((await creating).status, 'accepted');
  assert.equal((await sending).status, 'accepted');
  assert.deepEqual(f.calls, ['initial', 'later']);
});
test('stop rechecks its grant after the durable dispatch receipt', async (t) => {
  const f = await fixture(t),
    seed = await savedSession(f.bridge);
  let stops = 0;
  await f.update((c) => {
    c.defaults.stop = true;
  });
  f.runtime.generation = 'native-generation';
  f.runtime.stopExecution = async () => {
    stops++;
    throw Error('UNEXPECTED_STOP');
  };
  f.bridge.pool.instances.set(seed.session_id, f.runtime);
  const put = f.bridge.journal.put.bind(f.bridge.journal);
  t.mock.method(f.bridge.journal, 'put', async (id, value) => {
    await put(id, value);
    if (value.receipt.status === 'unknown' && value.receipt.generation)
      await f.update((c) => {
        c.defaults.stop = false;
      });
  });
  await assert.rejects(
    f.bridge.stop({ session_id: seed.session_id, request_id: 'stop-revoked' }),
    /NOT_FOUND_OR_DENIED/,
  );
  assert.equal(stops, 0);
  assert.equal((await f.bridge.journal.get('stop-revoked')).receipt.reason, 'NOT_FOUND_OR_DENIED');
});
test('delete rechecks its grant after owner release before moving the file', async (t) => {
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
    request_id: 'delete-revoked',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal((await fs.stat(session.file)).isFile(), true);
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
