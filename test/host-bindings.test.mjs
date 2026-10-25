import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkHostBinding, createRpcHostBinding } from '../src/host-bindings.mjs';

const idle = {
  sessionFile: '/public/session.jsonl',
  sessionId: 'public-id',
  isIdle: true,
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
};
function sdk(prompt) {
  return {
    ...idle,
    prompt,
    sessionManager: {
      getEntries: () => [{ id: 'entry', type: 'message' }],
      getLeafId: () => 'entry',
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('SDK read features expose current tool and command names without executing them', async () => {
  const value = sdk(() => assert.fail('Read features must not prompt'));
  value.getAllTools = () => [
    { name: 'memory_tool', description: 'PRIVATE_DESCRIPTION', parameters: { secret: true } },
  ];
  value.extensionRunner = {
    getRegisteredCommands: () => [
      {
        name: 'memory-command',
        handler: () => assert.fail('Read features must not execute a command'),
      },
    ],
  };
  assert.deepEqual(await createSdkHostBinding(value).readFeatures(), {
    available: true,
    tools: ['memory_tool'],
    commands: ['memory-command'],
    leaf_id: 'entry',
  });
});

test('RPC read features use registered extension commands and reject identity changes', async () => {
  const value = { ...idle };
  const client = {
    getState: async () => value,
    getCommands: async () => [
      { name: 'memory-command', source: 'extension', description: 'PRIVATE_DESCRIPTION' },
      { name: 'prompt-only', source: 'prompt' },
      { name: 'skill-only', source: 'skill' },
    ],
    getEntries: async () => ({ entries: [], leafId: 'entry' }),
  };
  const binding = createRpcHostBinding(client);
  assert.deepEqual(await binding.readFeatures(), {
    available: true,
    tools: [],
    commands: ['memory-command'],
    leaf_id: 'entry',
  });
  client.getEntries = async () => {
    value.sessionId = 'different';
    return { entries: [], leafId: null };
  };
  await assert.rejects(binding.readFeatures(), /RUNTIME_SESSION_CHANGED/);
});

test('SDK/RPC bindings expose only model identity and a valid native thinking level in state', async () => {
  const value = {
    ...idle,
    model: {
      provider: 'p',
      id: 'm',
      headers: { Authorization: 'SECRET' },
      apiKey: 'SECRET',
      baseUrl: 'SECRET',
    },
    thinkingLevel: 'max',
  };
  for (const binding of [
    createSdkHostBinding(value),
    createRpcHostBinding({ getState: async () => value }),
  ]) {
    const observed = await binding.state();
    assert.deepEqual(observed.model, { provider: 'p', id: 'm' });
    assert.equal(observed.thinkingLevel, 'max');
    assert.ok(!JSON.stringify(observed).includes('SECRET'));
  }
  delete value.model;
  value.thinkingLevel = 'invalid';
  for (const binding of [
    createSdkHostBinding(value),
    createRpcHostBinding({ getState: async () => value }),
  ]) {
    const observed = await binding.state();
    assert.equal(observed.model, null);
    assert.equal(observed.thinkingLevel, null);
  }
});

test('native setter identity changes block the second step and overlapping setters stay fenced', async () => {
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let thinkingCalls = 0;
  const value = {
    ...idle,
    model: { provider: 'p', id: 'a' },
    thinkingLevel: 'off',
    modelRuntime: { getAvailableSnapshot: () => [{ provider: 'p', id: 'b' }] },
    setModel: async (model) => {
      entered.resolve();
      await gate.promise;
      value.model = model;
      value.sessionId = 'another-session';
    },
    setThinkingLevel: () => {
      thinkingCalls++;
    },
  };
  const binding = createSdkHostBinding(value);
  const selection = binding.setModel({
    ...idle,
    model: { provider: 'p', id: 'b' },
    thinking_level: 'high',
  });
  await entered.promise;
  await assert.rejects(
    binding.setModel({ ...idle, thinking_level: 'low' }),
    /MODEL_SELECTION_PENDING/,
  );
  gate.resolve();
  await assert.rejects(selection, /RUNTIME_SESSION_CHANGED/);
  assert.equal(thinkingCalls, 0);
});

test('SDK dispatch confirms invocation without claiming admission or waiting for completion', async () => {
  const completion = Promise.withResolvers(),
    calls = [];
  let released = false;
  const binding = createSdkHostBinding(
    sdk((text, opts) => {
      calls.push([text, opts]);
      return completion.promise;
    }),
    {
      release: async () => {
        released = true;
        completion.resolve();
        return { released: true };
      },
    },
  );
  assert.deepEqual(await binding.submit({ text: 'public', mode: 'steer' }), {
    status: 'dispatched',
    admission: 'unobservable',
  });
  assert.deepEqual(calls, [['public', { streamingBehavior: 'steer' }]]);
  assert.equal(released, false);
  assert.deepEqual(await binding.release(), { released: true });
  assert.equal(released, true);
});

test('SDK later failure does not rewrite dispatch evidence and synchronous failure remains unknown', async () => {
  const completion = Promise.withResolvers(),
    errors = [];
  const binding = createSdkHostBinding(
    sdk(() => completion.promise),
    { onError: (error) => errors.push(error) },
  );
  const receipt = await binding.submit({ text: 'public', mode: 'follow_up' });
  completion.reject(new Error('PRIVATE_PROVIDER_ERROR'));
  await tick();
  assert.deepEqual(receipt, { status: 'dispatched', admission: 'unobservable' });
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
  const sync = createSdkHostBinding(
    sdk(() => {
      throw new Error('PRIVATE_SYNC_FAILURE');
    }),
  );
  assert.equal((await sync.submit({ text: 'public' })).status, 'unknown');
});

test('SDK snapshot retains native entries and idle-only busy never dispatches', async () => {
  let calls = 0;
  const session = sdk(() => {
    calls++;
  });
  session.isIdle = false;
  const binding = createSdkHostBinding(session);
  assert.deepEqual(await binding.submit({ text: 'public', mode: 'idle_only' }), {
    status: 'skipped',
    reason: 'busy',
  });
  assert.equal(calls, 0);
  assert.equal(binding.release, undefined);
  const entry = { id: 'entry', type: 'message' };
  session.sessionManager.getEntries = () => [entry];
  const snapshot = await binding.snapshot();
  assert.equal(snapshot.entries[0].id, 'entry');
  assert.equal(snapshot.sessionId, idle.sessionId);
});

test('RPC uses existing demultiplexed public client and preserves ACK dispositions', async () => {
  const calls = [];
  let disposition = 'handled';
  const client = {
    getState: async () => idle,
    getEntries: async () => ({ entries: [], leafId: null }),
    prompt: async (...args) => {
      calls.push(args);
      return disposition;
    },
  };
  const binding = createRpcHostBinding(client);
  for (const [input, behavior] of [
    [{}, 'steer'],
    [{ mode: 'idle_only' }, undefined],
    [{ mode: 'follow_up' }, 'followUp'],
  ]) {
    assert.deepEqual(await binding.submit({ text: 'public', ...input }), {
      status: 'accepted',
      disposition,
    });
    assert.deepEqual(calls.at(-1), ['public', undefined, behavior]);
    disposition = 'queued';
  }
  assert.equal(binding.release, undefined);
  assert.deepEqual(await binding.snapshot(), {
    sessionFile: idle.sessionFile,
    sessionId: idle.sessionId,
    entries: [],
    leafId: null,
  });
});

test('RPC plain rejection or timeout errors cannot be misreported as definite rejection', async () => {
  for (const message of ['PRIVATE_NEGATIVE_ACK', 'PRIVATE_TIMEOUT']) {
    const binding = createRpcHostBinding({
      prompt: async () => {
        throw new Error(message);
      },
    });
    const receipt = await binding.submit({ text: 'public' });
    assert.equal(receipt.status, 'unknown');
    assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
  }
});

test('RPC snapshot rejects session changes and observed busy prevents idle-only prompt', async () => {
  let calls = 0,
    reads = 0;
  const binding = createRpcHostBinding({
    getState: async () => ({ ...idle, isStreaming: true, sessionId: ++reads === 1 ? 'a' : 'b' }),
    getEntries: async () => ({ entries: [], leafId: null }),
    prompt: async () => {
      calls++;
    },
  });
  await assert.rejects(binding.snapshot(), /RUNTIME_SESSION_CHANGED/);
  assert.deepEqual(await binding.submit({ text: 'public', mode: 'idle_only' }), {
    status: 'skipped',
    reason: 'busy',
  });
  assert.equal(calls, 0);
});

test('RPC idle-only skips known pending input and preserves unknown-count admission', async () => {
  let calls = 0,
    pendingMessageCount = 1;
  const binding = createRpcHostBinding({
    getState: async () => ({ ...idle, pendingMessageCount }),
    prompt: async () => {
      calls++;
      return 'queued';
    },
  });
  assert.deepEqual(await binding.submit({ text: 'must not submit', mode: 'idle_only' }), {
    status: 'skipped',
    reason: 'busy',
  });
  assert.equal(calls, 0);
  for (const count of [0, null, undefined]) {
    pendingMessageCount = count;
    assert.deepEqual(await binding.submit({ text: 'no known pending input', mode: 'idle_only' }), {
      status: 'accepted',
      disposition: 'queued',
    });
  }
  assert.equal(calls, 3);
});

test('release requires explicit host confirmation and waits tracked dispatched work', async () => {
  const completion = Promise.withResolvers();
  let settled = false;
  const binding = createSdkHostBinding(
    sdk(() => completion.promise),
    { release: async () => ({ released: true }) },
  );
  await binding.submit({ text: 'public' });
  const releasing = binding.release().then((value) => {
    settled = true;
    return value;
  });
  await tick();
  assert.equal(settled, false);
  completion.resolve();
  await releasing;
  const unconfirmed = createSdkHostBinding(
    sdk(() => {}),
    { release: async () => ({}) },
  );
  await assert.rejects(unconfirmed.release(), /HOST_RELEASE_UNCONFIRMED/);
});

test('host bindings reject prompt settings before any native submission', async () => {
  for (const make of [createSdkHostBinding, createRpcHostBinding]) {
    let submitted = 0;
    const binding = make({
      ...sdk(() => {
        submitted++;
      }),
      getState: async () => idle,
    });
    for (const settings of [
      { model: { provider: 'p', id: 'm' } },
      { thinking_level: 'off' },
      { model: { provider: 'p', id: 'm' }, thinking_level: 'high' },
    ])
      await assert.rejects(
        binding.submit({ text: 'MUST_NOT_SEND', ...settings }),
        /MODEL_SELECTION_UNSUPPORTED/,
      );
    assert.equal(submitted, 0);
  }
});

test('SDK handled bash is recorded after stop; only fallback execution rechecks admission', async () => {
  for (const handled of [true, false]) {
    let stopping = false,
      recorded = 0,
      captured = 0;
    const result = {
      output: 'already executed by native hook',
      exitCode: 0,
      cancelled: false,
      truncated: false,
    };
    const session = {
      sessionFile: '/synthetic/native.jsonl',
      sessionId: 'native',
      sessionManager: { getCwd: () => '/synthetic' },
      clearQueue: () => ({ steering: [], followUp: [] }),
      abort: async () => {},
      abortBash: () => {},
      extensionRunner: {
        emitUserBash: async () => {
          stopping = true;
          return handled ? { result } : {};
        },
      },
      recordBashResult: () => {
        recorded++;
      },
      executeBash: () => assert.fail('stop forbids fallback execution'),
    };
    const work = createSdkHostBinding(session).bash({
      command: 'fixture',
      sessionFile: session.sessionFile,
      sessionId: session.sessionId,
      beforeDispatch: () => {
        if (stopping) throw new Error('STOP_IN_PROGRESS');
      },
      onResult: async (value) => {
        assert.deepEqual(value, { ...result, fullOutputPath: null });
        captured++;
      },
    });
    if (handled) {
      assert.deepEqual(await work, { ...result, fullOutputPath: null });
      assert.equal(recorded, 1);
      assert.equal(captured, 1);
    } else {
      await assert.rejects(work, /STOP_IN_PROGRESS/);
      assert.equal(recorded, 0);
      assert.equal(captured, 0);
    }
  }
});

class ReloadSession {
  constructor() {
    Object.assign(this, idle);
    this.sessionManager = {};
    this.reloadCalls = 0;
  }
  async prompt(work) {
    return await work;
  }
  async executeBash(work) {
    return await work;
  }
  async reload() {
    this.reloadCalls++;
    this.entered?.resolve();
    await this.reloadWork;
  }
}

test('SDK reload refuses local input preparation and fences local operations until native completion', async () => {
  const session = new ReloadSession(),
    binding = createSdkHostBinding(session),
    preparation = Promise.withResolvers();
  const preparing = session.prompt(preparation.promise);
  assert.equal(session.isIdle, true);
  assert.equal((await binding.state()).isIdle, false);
  await assert.rejects(
    binding.reload({
      ...idle,
      beforeDispatch: () => assert.fail('Busy reload must not dispatch'),
    }),
    /RELOAD_BUSY/,
  );
  assert.equal(session.reloadCalls, 0);
  preparation.resolve();
  await preparing;

  const completion = Promise.withResolvers();
  session.entered = Promise.withResolvers();
  session.reloadWork = completion.promise;
  let settled = false;
  const reloading = binding.reload({ ...idle }).then((result) => {
    settled = true;
    return result;
  });
  await session.entered.promise;
  assert.equal(settled, false);
  assert.equal((await binding.state()).isIdle, false);
  await assert.rejects(session.prompt('must not run'), /RELOAD_IN_PROGRESS/);
  await assert.rejects(session.executeBash('must not run'), /RELOAD_IN_PROGRESS/);
  completion.resolve();
  assert.deepEqual(await reloading, { reloaded: true });
  assert.equal((await binding.state()).isIdle, true);
  assert.equal(await session.prompt('continued'), 'continued');
});

test('SDK reload clears admission on dispatch rejection, native failure, and identity changes', async () => {
  const session = new ReloadSession(),
    binding = createSdkHostBinding(session);
  await assert.rejects(
    binding.reload({
      ...idle,
      beforeDispatch: () => {
        throw new Error('PERMISSION_REVOKED');
      },
    }),
    /PERMISSION_REVOKED/,
  );
  assert.equal(session.reloadCalls, 0);
  assert.equal(await session.prompt('still usable'), 'still usable');

  const failure = Promise.withResolvers();
  session.reloadWork = failure.promise;
  const failed = binding.reload({ ...idle });
  failure.reject(new Error('NATIVE_RELOAD_FAILED'));
  await assert.rejects(failed, /NATIVE_RELOAD_FAILED/);
  assert.equal((await binding.state()).isIdle, true);

  session.reloadWork = Promise.resolve().then(() => {
    session.sessionId = 'changed';
  });
  await assert.rejects(binding.reload({ ...idle }), /RUNTIME_SESSION_CHANGED/);
  assert.equal((await binding.state()).isIdle, true);

  // Object-based test substitutes must not install observers on Object.prototype.
  const unsupported = createSdkHostBinding({ ...sdk(() => {}), reload: async () => {} });
  assert.equal(unsupported.reload, undefined);
});

test('RPC reload delegates safe admission and waits host confirmation on the same native session', async () => {
  const value = { ...idle },
    completion = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let dispatched = 0,
    settled = false;
  const client = {
    getState: async () => value,
    prompt: () => assert.fail('Reload must not submit a prompt'),
  };
  assert.equal(createRpcHostBinding(client).reload, undefined);
  const binding = createRpcHostBinding(client, {
    reload: async ({ sessionFile, sessionId, beforeDispatch }) => {
      assert.deepEqual(
        { sessionFile, sessionId },
        {
          sessionFile: idle.sessionFile,
          sessionId: idle.sessionId,
        },
      );
      beforeDispatch();
      entered.resolve();
      return await completion.promise;
    },
  });
  const work = binding.reload({ ...idle, beforeDispatch: () => dispatched++ }).then((result) => {
    settled = true;
    return result;
  });
  await entered.promise;
  assert.equal(dispatched, 1);
  assert.equal(settled, false);
  completion.resolve({ reloaded: true });
  assert.deepEqual(await work, { reloaded: true });

  const switched = createRpcHostBinding(client, {
    reload: async () => {
      value.sessionId = 'another';
      return { reloaded: true };
    },
  });
  await assert.rejects(switched.reload({ ...idle }), /RUNTIME_SESSION_CHANGED/);
});

test('RPC reload preserves host busy refusal and requires explicit completion', async () => {
  const client = { getState: async () => idle };
  const busy = createRpcHostBinding(client, {
    reload: async () => {
      throw new Error('RELOAD_BUSY');
    },
  });
  await assert.rejects(
    busy.reload({
      ...idle,
      beforeDispatch: () => assert.fail('Busy reload must not dispatch'),
    }),
    /RELOAD_BUSY/,
  );
  const unconfirmed = createRpcHostBinding(client, {
    reload: async () => ({ accepted: true }),
  });
  await assert.rejects(unconfirmed.reload({ ...idle }), /RELOAD_UNCONFIRMED/);
});
