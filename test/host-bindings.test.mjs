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

function selectionHost(kind) {
  const models = [
      { provider: 'fixture', id: 'alpha', reasoning: true },
      { provider: 'fixture', id: 'beta', reasoning: true },
    ],
    calls = [];
  const native = {
    ...sdk(async () => {
      calls.push('prompt');
      return 'started';
    }),
    model: models[0],
    thinkingLevel: 'off',
    modelRuntime: { getAvailableSnapshot: () => models },
    getAvailableModels: async () => models,
    getState: async () => ({ ...idle, model: native.model, thinkingLevel: native.thinkingLevel }),
    setModel: async (model, id) => {
      calls.push('setModel');
      native.model = kind === 'SDK' ? model : models.find((m) => m.id === id);
    },
    setThinkingLevel: (level) => {
      calls.push('setThinkingLevel');
      native.thinkingLevel = level;
    },
  };
  const binding = kind === 'SDK' ? createSdkHostBinding(native) : createRpcHostBinding(native);
  return { kind, native, binding, models, calls };
}

async function assertSelectionUsable({ kind, native, binding, models, calls }) {
  const submitted = await binding.submit({ text: 'after recoverable selection failure' });
  assert.equal(submitted.status, kind === 'SDK' ? 'unknown' : 'accepted');
  assert.equal(calls.at(-1), 'prompt');
  const target = models.find((m) => m.id !== native.model.id),
    selected = await binding.selectModel({ model: target, thinking_level: 'high' });
  assert.deepEqual(selected.model, { provider: target.provider, id: target.id });
  assert.equal(selected.thinking_level, 'high');
  assert.deepEqual(calls.slice(-2), ['setModel', 'setThinkingLevel']);
}

test('SDK dispatch reports unknown without waiting for completion and tracks drain', async () => {
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
    status: 'unknown',
    dispatch: 'submitted',
    reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
    completion: 'not_tracked',
  });
  assert.deepEqual(calls, [['public', { streamingBehavior: 'steer' }]]);
  assert.equal(released, false);
  assert.deepEqual(await binding.release(), { released: true });
  assert.equal(released, true);
});

test('SDK completion failure stays unknown and raw failures remain host-local', async () => {
  const completion = Promise.withResolvers(),
    errors = [];
  const binding = createSdkHostBinding(
    sdk(() => completion.promise),
    { onError: (error) => errors.push(error) },
  );
  const receipt = await binding.submit({ text: 'public', mode: 'follow_up' });
  completion.reject(new Error('PRIVATE_PROVIDER_ERROR'));
  await tick();
  assert.equal(receipt.status, 'unknown');
  assert.equal(errors.length, 1);
  assert.equal(JSON.stringify(receipt).includes('PRIVATE'), false);
  const sync = createSdkHostBinding(
    sdk(() => {
      throw new Error('PRIVATE_SYNC_FAILURE');
    }),
  );
  assert.equal((await sync.submit({ text: 'public' })).status, 'unknown');
});

test('SDK snapshot clones entries and idle-only busy never dispatches', async () => {
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
  entry.id = 'later';
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
  for (const [mode, behavior] of [
    ['default', 'steer'],
    ['idle_only', undefined],
    ['steer', 'steer'],
    ['follow_up', 'followUp'],
  ]) {
    assert.deepEqual(await binding.submit({ text: 'public', mode }), {
      status: 'accepted',
      disposition,
      completion: 'not_tracked',
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
      completion: 'not_tracked',
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

for (const kind of ['SDK', 'RPC']) {
  for (const phase of ['initial check', 'no-op second check', 'second check after model ACK']) {
    test(
      kind + ' selection classifies admission failure after ' + phase + ' without fencing input',
      async () => {
        const f = selectionHost(kind),
          failure = new Error('STOP_IN_PROGRESS'),
          partial = phase === 'second check after model ACK';
        let checks = 0;
        await assert.rejects(
          f.binding.selectModel({
            model: f.models[partial ? 1 : 0],
            thinking_level: 'high',
            beforeDispatch: () => {
              if (++checks === (phase === 'initial check' ? 1 : 2)) throw failure;
            },
          }),
          (error) =>
            partial
              ? error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true
              : error === failure && error.uncertain !== true,
        );
        assert.deepEqual(f.calls, partial ? ['setModel'] : []);
        assert.equal(f.native.model.id, partial ? 'beta' : 'alpha');
        assert.equal(f.native.thinkingLevel, 'off');
        await assertSelectionUsable(f);
      },
    );
  }
}

for (const phase of ['no-op', 'model ACK', 'thinking ACK', 'both ACKs']) {
  test(
    'RPC selection final read failure after ' + phase + ' leaves submit and selection usable',
    async () => {
      const f = selectionHost('RPC'),
        getState = f.native.getState,
        failure = new Error('PRIVATE_STATE_READ_FAILURE'),
        changeModel = ['model ACK', 'both ACKs'].includes(phase),
        changeThinking = ['thinking ACK', 'both ACKs'].includes(phase);
      let reads = 0;
      f.native.getState = async () => {
        if (++reads === 2) throw failure;
        return getState();
      };
      await assert.rejects(
        f.binding.selectModel({
          model: f.models[changeModel ? 1 : 0],
          ...(changeThinking ? { thinking_level: 'high' } : {}),
        }),
        (error) =>
          changeModel || changeThinking
            ? error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true
            : error === failure && error.uncertain !== true,
      );
      assert.deepEqual(f.calls, [
        ...(changeModel ? ['setModel'] : []),
        ...(changeThinking ? ['setThinkingLevel'] : []),
      ]);
      assert.equal(f.native.model.id, changeModel ? 'beta' : 'alpha');
      assert.equal(f.native.thinkingLevel, changeThinking ? 'high' : 'off');
      await assertSelectionUsable(f);
    },
  );
}

test('RPC invalid final metadata after model ACK does not fence later native work', async () => {
  const f = selectionHost('RPC'),
    getState = f.native.getState;
  let reads = 0;
  f.native.getState = async () => (++reads === 2 ? { ...idle, thinkingLevel: 'off' } : getState());
  await assert.rejects(
    f.binding.selectModel({ model: f.models[1] }),
    (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
  );
  assert.deepEqual(f.calls, ['setModel']);
  await assertSelectionUsable(f);
});

test('SDK final metadata failure after model ACK is uncertain without fencing later work', async () => {
  const f = selectionHost('SDK'),
    setModel = f.native.setModel;
  f.native.setModel = async (...args) => {
    await setModel(...args);
    f.native.model = undefined;
  };
  await assert.rejects(
    f.binding.selectModel({ model: f.models[1] }),
    (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
  );
  assert.deepEqual(f.calls, ['setModel']);
  f.native.model = f.models[1];
  f.native.setModel = setModel;
  await assertSelectionUsable(f);
});

test('RPC confirmed model change does not hide an unconfirmed later thinking change', async () => {
  const f = selectionHost('RPC'),
    completion = Promise.withResolvers(),
    entered = Promise.withResolvers();
  f.native.setThinkingLevel = async () => {
    f.calls.push('setThinkingLevel');
    entered.resolve();
    await completion.promise;
  };
  const selection = f.binding.selectModel({ model: f.models[1], thinking_level: 'high' }),
    rejected = assert.rejects(
      selection,
      (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
    );
  await entered.promise;
  assert.equal(f.native.model.id, 'beta');
  assert.equal(f.native.thinkingLevel, 'off');
  await assert.rejects(
    f.binding.submit({ text: 'cannot race thinking change' }),
    /MODEL_SELECTION_PENDING/,
  );
  completion.reject(new Error('PRIVATE_TIMEOUT'));
  await rejected;
  await f.binding.state();
  await assert.rejects(
    f.binding.submit({ text: 'still cannot race thinking change' }),
    /MODEL_SELECTION_PENDING/,
  );
  await assert.rejects(f.binding.selectModel({ model: f.models[0] }), /MODEL_SELECTION_PENDING/);
  assert.deepEqual(f.calls, ['setModel', 'setThinkingLevel']);
});

for (const method of ['setModel', 'setThinkingLevel']) {
  test(
    'RPC ' + method + ' fences input while awaiting ACK and resumes after confirmation',
    async () => {
      const f = selectionHost('RPC'),
        completion = Promise.withResolvers(),
        entered = Promise.withResolvers(),
        change = f.native[method];
      f.native[method] = async (...args) => {
        entered.resolve();
        await completion.promise;
        return change(...args);
      };
      const selection = f.binding.selectModel(
        method === 'setModel' ? { model: f.models[1] } : { thinking_level: 'high' },
      );
      await entered.promise;
      await assert.rejects(
        f.binding.submit({ text: 'cannot race native change' }),
        /MODEL_SELECTION_PENDING/,
      );
      await assert.rejects(
        f.binding.selectModel({ model: f.models[0] }),
        /MODEL_SELECTION_PENDING/,
      );
      assert.deepEqual(f.calls, []);
      completion.resolve();
      await selection;
      f.native[method] = change;
      await assertSelectionUsable(f);
    },
  );

  for (const message of ['PRIVATE_NEGATIVE_ACK', 'Timeout waiting for response to ' + method]) {
    test(
      'RPC ' + method + ' plain Error (' + message + ') retains unconfirmed mutation protection',
      async () => {
        const f = selectionHost('RPC');
        f.native[method] = async () => {
          f.calls.push(method);
          // Pi 1.1 exposes neither the negative ACK response nor a timeout tag.
          throw new Error(message);
        };
        await assert.rejects(
          f.binding.selectModel(
            method === 'setModel' ? { model: f.models[1] } : { thinking_level: 'high' },
          ),
          (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
        );
        assert.deepEqual(f.calls, [method]);
        // Even observing the requested value later does not prove a timed-out
        // command has finished; it could still be in a native hook.
        f.native.model = f.models[1];
        f.native.thinkingLevel = 'high';
        await f.binding.state();
        await f.binding.models({});
        await assert.rejects(
          f.binding.submit({ text: 'cannot race late native change' }),
          /MODEL_SELECTION_PENDING/,
        );
        await assert.rejects(
          f.binding.selectModel({ model: f.models[0] }),
          /MODEL_SELECTION_PENDING/,
        );
        assert.deepEqual(f.calls, [method]);
      },
    );
  }

  test('RPC synchronous ' + method + ' failure remains conservatively fenced', async () => {
    const f = selectionHost('RPC');
    f.native[method] = () => {
      f.calls.push(method);
      throw new Error('PRIVATE_NATIVE_FAILURE');
    };
    await assert.rejects(
      f.binding.selectModel(
        method === 'setModel' ? { model: f.models[1] } : { thinking_level: 'high' },
      ),
      (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
    );
    await assert.rejects(
      f.binding.submit({ text: 'cannot race late native change' }),
      /MODEL_SELECTION_PENDING/,
    );
    await assert.rejects(f.binding.selectModel({ model: f.models[0] }), /MODEL_SELECTION_PENDING/);
    assert.deepEqual(f.calls, [method]);
  });

  test('SDK native ' + method + ' failure remains uncertain', async () => {
    const f = selectionHost('SDK');
    f.native[method] = () => {
      throw new Error('PRIVATE_NATIVE_FAILURE');
    };
    await assert.rejects(
      f.binding.selectModel(
        method === 'setModel' ? { model: f.models[1] } : { thinking_level: 'high' },
      ),
      (error) => error.message === 'MODEL_SELECTION_FAILED' && error.uncertain === true,
    );
  });
}

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
      assert.equal((await work).completed, true);
      assert.equal(recorded, 1);
      assert.equal(captured, 1);
    } else {
      await assert.rejects(work, /STOP_IN_PROGRESS/);
      assert.equal(recorded, 0);
      assert.equal(captured, 0);
    }
  }
});
