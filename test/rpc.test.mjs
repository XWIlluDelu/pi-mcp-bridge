import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RpcFailure, RuntimePool, launchProfile } from '../src/rpc.mjs';

test('compact RPC rejection exposes only exact safe native reasons', async () => {
  const known = [
    'Nothing to compact (session too small)',
    'Already compacted',
    'Compaction cancelled',
  ];
  for (const [command, message, expected] of [
    ...known.map((message) => ['compact', message, message]),
    ['compact', 'Provider failed: secret-key /private/session user text', undefined],
    ['compact', known[0] + '\n/private/session', undefined],
    ['compact', { message: known[0], secret: 'private' }, undefined],
    ['bash', known[0], undefined],
  ]) {
    const rpc = new PiRpc({}, {});
    const failure = new Promise((resolve) =>
      rpc.pending.set('request', {
        commandType: command,
        generation: rpc.generation,
        reject: resolve,
      }),
    );
    rpc.receiveResponse(
      { type: 'response', id: 'request', command, success: false, error: message },
      rpc.generation,
    );
    const error = await failure;
    assert.equal(error.code, 'PI_REJECTED');
    assert.equal(error.message, 'PI_REJECTED');
    assert.equal(error.uncertain, false);
    assert.equal(error.native_reason, expected);
    assert.ok(!JSON.stringify(error).includes('private'));
  }
});

test('launcher uses native defaults and only explicit owner overrides', () => {
  const host = {
    PATH: '/bin',
    OPENAI_API_KEY: 'synthetic-key',
    HTTPS_PROXY: 'http://synthetic-proxy',
    HOME: '/owner',
    PI_CODING_AGENT_DIR: '/native-agent',
    LANG: 'test-locale',
  };
  const config = { stateDir: '/tmp/state' },
    native = launchProfile(config, host);
  assert.deepEqual(native.env, host);
  assert.notEqual(native.env, host);
  assert.deepEqual(native.toolArgs, []);
  const selected = launchProfile(
    {
      ...config,
      piRuntime: { agentDir: '/tmp/pi-profile', inheritEnv: ['HOME'], tools: ['read', 'write'] },
    },
    host,
  );
  assert.equal(selected.env.OPENAI_API_KEY, undefined);
  assert.equal(selected.env.HOME, '/owner');
  assert.equal(selected.env.PI_CODING_AGENT_DIR, '/tmp/pi-profile');
  assert.deepEqual(selected.toolArgs, ['--tools', 'read,write']);
  assert.deepEqual(launchProfile({ ...config, piRuntime: { tools: [] } }, host).toolArgs, [
    '--no-tools',
  ]);
  const homeOnly = launchProfile({ ...config, piRuntime: { inheritEnv: ['HOME'] } }, host);
  assert.equal(homeOnly.env.PI_CODING_AGENT_DIR, undefined);
  assert.equal(homeOnly.env.HOME, '/owner');
  assert.throws(
    () => launchProfile({ ...config, piRuntime: { agentDir: 'relative' } }),
    /INVALID_PI_RUNTIME/,
  );
});

for (const field of ['inheritEnv', 'tools'])
  test(`null ${field} uses the same native launch defaults as omission`, () => {
    for (const host of [
      { HOME: '/synthetic-home', NATIVE_VALUE: 'inherited' },
      { PATH: '/bin', HOME: '/synthetic-home', NATIVE_VALUE: 'inherited' },
    ]) {
      const omitted = launchProfile({}, host),
        config = { piRuntime: { [field]: null } };
      assert.deepEqual(launchProfile(config, host), omitted);
      assert.deepEqual(config, { piRuntime: { [field]: null } });
    }
  });

test('mismatched Pi state refuses read/send without terminating or dispatching under the wrong identity', async () => {
  for (const command of [{ type: 'get_entries' }, { type: 'prompt', message: 'fixture' }]) {
    const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
    let stopped = false;
    const calls = [];
    rpc.stop = async () => {
      stopped = true;
    };
    rpc.dispatch = async (c) => {
      calls.push(c.type);
      return { sessionFile: '/sessions/b.jsonl', sessionId: 'b' };
    };
    await assert.rejects(rpc.command(command), { code: 'RUNTIME_SESSION_CHANGED' });
    assert.equal(stopped, false);
    assert.deepEqual(calls, ['get_state']);
  }
});

test('identity change during read suppresses content; during prompt preserves uncertainty', async () => {
  for (const type of ['get_entries', 'prompt']) {
    const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
    let states = 0;
    rpc.stop = async () => {};
    rpc.dispatch = async (c) =>
      c.type === 'get_state'
        ? ++states === 1
          ? { sessionFile: '/sessions/a.jsonl', sessionId: 'a' }
          : { sessionFile: '/sessions/b.jsonl', sessionId: 'b' }
        : { entries: ['private'], disposition: 'started' };
    await assert.rejects(
      rpc.command({ type }),
      (error) =>
        error.code === 'RUNTIME_SESSION_CHANGED' && error.uncertain === (type === 'prompt'),
    );
  }
});

test('authoritative Pi rejection still verifies identity without terminating a switched process', async () => {
  const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
  let states = 0,
    stopped = false;
  rpc.stop = async () => {
    stopped = true;
  };
  rpc.dispatch = async (c) => {
    if (c.type !== 'get_state') throw new RpcFailure('PI_REJECTED');
    return ++states === 1
      ? { sessionFile: '/sessions/a.jsonl', sessionId: 'a' }
      : { sessionFile: '/sessions/b.jsonl', sessionId: 'b' };
  };
  await assert.rejects(
    rpc.command({ type: 'prompt' }),
    (error) => error.code === 'RUNTIME_SESSION_CHANGED' && error.uncertain,
  );
  assert.equal(stopped, false);
  assert.equal(states, 2);
});

test('RPC pipe failure still requires confirmed process exit before stop returns', async () => {
  const rpc = new PiRpc({}, {});
  rpc.assertProcessIdentity = async () => {}; // Synthetic child, not an OS process.
  const child = new EventEmitter();
  let terminated = false,
    exited = false;
  child.kill = () => {
    terminated = true;
    setImmediate(() => {
      exited = true;
      child.emit('exit', 0);
    });
  };
  rpc.child = child;
  rpc.alive = false;
  rpc.exited = false;
  await rpc.stop();
  assert.equal(terminated, true);
  assert.equal(exited, true);
});
test('shutdown preparation reports failed SIGTERM and explicit stop can retry without a stale promise', async () => {
  const rpc = new PiRpc({}, {}),
    child = new EventEmitter(),
    signals = [];
  rpc.child = child;
  rpc.assertProcessIdentity = async () => {}; // Synthetic child.
  rpc.alive = true;
  child.kill = (signal) => {
    signals.push(signal);
    throw Object.assign(new Error('test signal denied'), { code: 'EPERM' });
  };
  await assert.rejects(rpc.stop(), { code: 'EPERM' });
  assert.equal(child.listenerCount('exit'), 1); // One reusable lifetime exit observer.
  child.kill = () => false;
  const pool = new RuntimePool({});
  pool.instances.set('synthetic', rpc);
  rpc.gracefulExitPromise = Promise.resolve();
  await assert.rejects(pool.prepareClose(), { code: 'RUNTIME_STOP_FAILED' });
  assert.equal(child.listenerCount('exit'), 1); // One reusable lifetime exit observer.
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit('exit', 0));
    return true;
  };
  await rpc.stop();
  assert.deepEqual(signals, ['SIGTERM', 'SIGTERM']);
  assert.equal(rpc.exited, true);
});
test('owner termination waits for exit without timer-based SIGKILL', async () => {
  const rpc = new PiRpc({}, {}),
    child = new EventEmitter(),
    signals = [];
  rpc.child = child;
  rpc.assertProcessIdentity = async () => {}; // Synthetic child.
  rpc.alive = true;
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  let stopped = false;
  const stopping = rpc.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 1650));
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(stopped, false);
  child.emit('exit', 0);
  await stopping;
  assert.equal(stopped, true);
  assert.equal(rpc.exited, true);
});
test('pool terminates an unusable old runtime before replacement', async () => {
  let stopped = false;
  const pool = new RuntimePool({}, async () => {
    assert.equal(stopped, true);
    return { alive: true, stop: async () => {} };
  });
  pool.instances.set('s', {
    alive: false,
    stop: async () => {
      await new Promise((r) => setImmediate(r));
      stopped = true;
    },
  });
  await pool.resolve({ id: 's' });
  await pool.close();
});

test('unresolved prompt admission survives timeout, idle, malformed and old-generation replies', async () => {
  const rpc = new PiRpc({}, {}),
    writes = [];
  rpc.alive = true;
  rpc.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) } };
  let late;
  await assert.rejects(
    rpc.dispatch({ type: 'prompt', message: 'first' }, 10, (result) => {
      late = result;
    }),
    { code: 'ACK_TIMEOUT', uncertain: true },
  );
  const first = writes[0],
    generation = rpc.generation;
  const state = rpc.dispatch({ type: 'get_state' }, 1000);
  const stateRequest = writes.at(-1);
  rpc.receiveResponse(
    { type: 'response', id: stateRequest.id, success: true, data: { isStreaming: false } },
    generation,
  );
  await state;
  for (const event of [
    { type: 'agent_settled', aborted: false },
    {
      type: 'response',
      id: first.id,
      command: 'get_state',
      success: true,
      data: { disposition: 'started' },
    },
    { type: 'response', id: first.id, command: 'prompt', success: true, data: {} },
  ])
    rpc.receiveResponse(event, generation);
  const ack = {
    type: 'response',
    id: first.id,
    command: 'prompt',
    success: true,
    data: { disposition: 'started' },
  };
  rpc.receiveResponse(ack, 'old-generation');
  await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'second' }), {
    code: 'PROMPT_ADMISSION_PENDING',
    uncertain: false,
  });
  assert.equal(writes.filter((x) => x.type === 'prompt').length, 1);
  rpc.receiveResponse(ack, generation);
  assert.equal(late.data.disposition, 'started');
  const next = rpc.dispatch({ type: 'prompt', message: 'next', streamingBehavior: 'steer' }, 1000),
    nextRequest = writes.at(-1);
  rpc.receiveResponse(ack, generation);
  assert.equal(rpc.promptAdmission.id, nextRequest.id);
  rpc.receiveResponse(
    {
      type: 'response',
      id: nextRequest.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'queued' },
    },
    generation,
  );
  assert.equal((await next).disposition, 'queued');
});
test('write uncertainty retains admission; authoritative rejection or confirmed exit releases it', async () => {
  for (const failure of ['callback', 'throw']) {
    const rpc = new PiRpc({}, {});
    rpc.assertProcessIdentity = async () => {}; // Synthetic child.
    rpc.alive = true;
    let written;
    const child = new EventEmitter();
    child.stdin = {
      write: (line, cb) => {
        written = JSON.parse(line);
        if (failure === 'throw') throw new Error('synthetic');
        cb(new Error('synthetic'));
      },
    };
    rpc.child = child;
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'first' }, 1000), {
      code: 'WRITE_UNKNOWN',
      uncertain: true,
    });
    assert.ok(rpc.promptAdmission);
    await assert.rejects(rpc.dispatch({ type: 'prompt', message: 'second' }), {
      code: 'PROMPT_ADMISSION_PENDING',
    });
    if (failure === 'callback') {
      rpc.receiveResponse(
        { type: 'response', id: written.id, command: 'prompt', success: false },
        rpc.generation,
      );
      assert.equal(rpc.promptAdmission, null);
    } else {
      child.kill = () => {
        assert.ok(rpc.promptAdmission);
        setImmediate(() => child.emit('exit', 0));
      };
      await rpc.stop();
      assert.equal(rpc.promptAdmission, null);
      assert.equal(rpc.exited, true);
    }
  }
});

test('silent live child does not retain expired read requests while prompt ACK recovery stays fenced', async () => {
  const rpc = new PiRpc({}, {}),
    writes = [];
  rpc.alive = true;
  rpc.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) } };
  let lateReads = 0;
  for (let i = 0; i < 12; i++) {
    await assert.rejects(
      rpc.dispatch({ type: i % 2 ? 'get_entries' : 'get_state' }, 1, () => lateReads++),
      { code: 'ACK_TIMEOUT' },
    );
    assert.equal(rpc.pending.size, 0);
    assert.equal(rpc.promptAdmission, null);
  }
  for (const request of writes)
    rpc.receiveResponse(
      { type: 'response', id: request.id, success: true, data: {} },
      rpc.generation,
    );
  assert.equal(lateReads, 0);
  let latePrompt;
  await assert.rejects(
    rpc.dispatch({ type: 'prompt', message: 'held' }, 1, (result) => {
      latePrompt = result;
    }),
    { code: 'ACK_TIMEOUT' },
  );
  const prompt = writes.at(-1);
  assert.equal(rpc.pending.size, 1);
  for (const failure of ['callback', 'throw']) {
    rpc.child.stdin.write = (_line, cb) => {
      if (failure === 'throw') throw new Error('fixture');
      cb(new Error('fixture'));
    };
    await assert.rejects(rpc.dispatch({ type: 'get_entries' }, 50), { code: 'WRITE_UNKNOWN' });
    assert.equal(rpc.pending.size, 1);
    assert.equal(rpc.promptAdmission.id, prompt.id);
  }
  rpc.receiveResponse(
    {
      type: 'response',
      id: prompt.id,
      command: 'prompt',
      success: true,
      data: { disposition: 'started' },
    },
    rpc.generation,
  );
  assert.equal(latePrompt.ok, true);
  assert.equal(rpc.pending.size, 0);
  assert.equal(rpc.promptAdmission, null);
});

test('actual RPC launch rejects null, missing and symlink-replaced cwd without spawning', async (t) => {
  const fs = await import('node:fs/promises'),
    path = await import('node:path');
  const dir = await fs.mkdtemp('/tmp/pi-cwd-launch-');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const kind of ['null', 'missing', 'symlink', 'after-reservation']) {
    const root = path.join(dir, kind),
      cwd = path.join(root, 'project');
    await fs.mkdir(cwd, { recursive: true });
    const file = path.join(root, 'session.jsonl'),
      header = { type: 'session', version: 3, id: kind, cwd };
    await fs.writeFile(file, JSON.stringify(header) + '\n');
    const config = {
      piExecutable: nativePiCli,
      stateDir: path.join(root, 'state'),
      attachmentDir: path.join(root, 'ipc'),
    };
    const session = { file, header, cwd: kind === 'null' ? null : cwd };
    if (kind === 'missing') await fs.rmdir(cwd);
    if (kind === 'symlink') {
      await fs.rename(cwd, cwd + '-moved');
      await fs.symlink(cwd + '-moved', cwd);
    }
    const rename = fs.default.rename;
    let retargeted = false;
    if (kind === 'after-reservation')
      t.mock.method(fs.default, 'rename', async (from, to) => {
        await rename(from, to);
        if (to.endsWith('.owner.json') && !retargeted) {
          retargeted = true;
          await rename(cwd, cwd + '-moved');
          await fs.symlink(cwd + '-moved', cwd);
        }
      });
    const rpc = new PiRpc(config, session);
    try {
      await assert.rejects(rpc.start(), /EXECUTION_CWD_UNAVAILABLE/);
      assert.equal(rpc.child, undefined);
      assert.equal(rpc.alive, false);
      assert.deepEqual(
        (await fs.readdir(config.attachmentDir)).filter((name) => name.endsWith('.owner.json')),
        [],
      );
      if (kind === 'after-reservation') assert.equal(retargeted, true);
    } finally {
      t.mock.restoreAll();
      await rpc.stop();
    }
  }
});

test('post-ACK identity failures preserve already observed UI facts and uncertainty', async () => {
  const rpc = new PiRpc({}, { file: '/sessions/a.jsonl', header: { id: 'a' } });
  let states = 0;
  const ui = { cancel_sent: ['confirm'], completion: 'unconfirmed' };
  rpc.dispatch = async (command) => {
    if (command.type === 'get_state') {
      if (++states === 1) return { sessionFile: rpc.session.file, sessionId: 'a' };
      throw new RpcFailure('RUNTIME_DISCONNECTED');
    }
    return { disposition: 'handled', ui };
  };
  await assert.rejects(rpc.command({ type: 'prompt', message: 'x' }), (error) => {
    assert.equal(error.uncertain, true);
    assert.deepEqual(error.ui, ui);
    return true;
  });
});

test('stop tolerates exact natural exit during identity validation, but never signals a live mismatched process', async () => {
  for (const exited of [true, false]) {
    const rpc = new PiRpc({}, {}),
      child = new EventEmitter();
    rpc.child = child;
    rpc.alive = true;
    let signals = 0;
    child.kill = () => {
      signals++;
      return true;
    };
    rpc.assertProcessIdentity = async () => {
      if (exited) child.emit('exit', 0, null);
      throw new RpcFailure('RUNTIME_SESSION_CHANGED');
    };
    if (exited) await rpc.stop();
    else await assert.rejects(rpc.stop(), /RUNTIME_SESSION_CHANGED/);
    assert.equal(signals, 0);
    assert.equal(rpc.exited, exited);
  }
});
