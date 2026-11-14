import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkHostBinding, createRpcHostBinding } from '../src/host-bindings.mjs';
import { sdkSession } from './fixtures/sdk-session.mjs';

const idle = {
  sessionFile: '/public/session.jsonl',
  sessionId: 'public-id',
  isIdle: true,
  isStreaming: false,
  isCompacting: false,
  pendingMessageCount: 0,
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('SDK dispatch confirms invocation without claiming admission or waiting for completion', async () => {
  const completion = Promise.withResolvers(),
    calls = [];
  let released = false;
  const binding = createSdkHostBinding(
    sdkSession({
      ...idle,
      prompt(text, opts) {
        calls.push([text, opts]);
        return completion.promise;
      },
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

test('SDK idle-only skips local input preparation while ordinary delivery remains available', async () => {
  const preparation = Promise.withResolvers(),
    prompts = [];
  const session = sdkSession({
    ...idle,
    async prompt(input) {
      prompts.push(input);
      return await input;
    },
  });
  const binding = createSdkHostBinding(session),
    preparing = session.prompt(preparation.promise);
  assert.equal(session.isIdle, true);
  assert.equal((await binding.state()).isIdle, false);
  assert.deepEqual(await binding.submit({ text: 'must not enter', mode: 'idle_only' }), {
    status: 'skipped',
    reason: 'busy',
  });
  assert.deepEqual(prompts, [preparation.promise]);
  for (const mode of ['steer', 'follow_up'])
    assert.deepEqual(await binding.submit({ text: mode, mode }), {
      status: 'dispatched',
      admission: 'unobservable',
    });
  preparation.resolve();
  await preparing;
  await tick();
  assert.equal((await binding.state()).isIdle, true);
  assert.deepEqual(await binding.submit({ text: 'now idle', mode: 'idle_only' }), {
    status: 'dispatched',
    admission: 'unobservable',
  });
  assert.deepEqual(prompts, [preparation.promise, 'steer', 'follow_up', 'now idle']);
});

const rpcClient = (methods) => ({
  getAvailableModels: () => [],
  setModel: () => {},
  setThinkingLevel: () => {},
  ...methods,
});

test('RPC plain rejection or timeout errors cannot be misreported as definite rejection', async () => {
  assert.throws(() => createRpcHostBinding({}), /INVALID_HOST_CALLBACKS/);
  for (const message of ['PRIVATE_NEGATIVE_ACK', 'PRIVATE_TIMEOUT']) {
    const binding = createRpcHostBinding(
      rpcClient({
        prompt: async () => {
          throw new Error(message);
        },
      }),
    );
    const receipt = await binding.submit({ text: 'public' });
    assert.equal(receipt.status, 'unknown');
    assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
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
    const session = sdkSession({
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
    });
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

test('SDK bash preparation and result delivery stay busy for idle-only and reload', async () => {
  const prepare = Promise.withResolvers(),
    execute = Promise.withResolvers();
  const delivery = Promise.withResolvers(),
    delivering = Promise.withResolvers();
  const session = sdkSession({
    ...idle,
    extensionRunner: { emitUserBash: () => prepare.promise },
    executeBash: () => execute.promise,
    prompt: () => assert.fail('Unexpected prompt'),
  });
  const binding = createSdkHostBinding(session);
  const work = binding.bash({
    ...idle,
    command: 'fixture',
    onResult: () => {
      delivering.resolve();
      return delivery.promise;
    },
  });
  const assertBusy = async () => {
    assert.equal((await binding.state()).isIdle, false);
    assert.equal((await binding.submit({ text: 'busy', mode: 'idle_only' })).status, 'skipped');
    await assert.rejects(binding.reload(idle), /RELOAD_BUSY/);
  };
  await assertBusy();
  prepare.resolve({});
  await tick();
  await assertBusy();
  execute.resolve({ output: 'fixture', exitCode: 0, cancelled: false, truncated: false });
  await delivering.promise;
  await assertBusy();
  delivery.resolve();
  await work;
  assert.deepEqual(await binding.reload(idle), { reloaded: true });
});

test('RPC reload delegates safe admission and waits host confirmation on the same native session', async () => {
  const value = { ...idle },
    completion = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let dispatched = 0,
    settled = false;
  const client = rpcClient({
    getState: async () => value,
    prompt: () => assert.fail('Reload must not submit a prompt'),
  });
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

test('SDK idle compact rechecks identity at native dispatch after the state await', async () => {
  let calls = 0;
  const session = sdkSession({
    ...idle,
    async compact() {
      calls++;
    },
  });
  const binding = createSdkHostBinding(session);
  queueMicrotask(() => {
    session.sessionId = 'different-session';
  });
  await assert.rejects(binding.compact(idle), /RUNTIME_SESSION_CHANGED/);
  assert.equal(calls, 0);
  assert.equal((await binding.state()).isIdle, true, 'failed admission releases its gate');
});
