import { ALL_CONTENT } from '../src/read-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from './fixtures/pi.mjs';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  RpcClient,
} from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import attachExtension from '../src/companion.mjs';
import { claimFile, readClaim } from '../src/attachments.mjs';
import { pathToFileURL } from 'node:url';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createSdkHostBinding } from '../src/host-bindings.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

async function until(check) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('COMPANION_LIFECYCLE_TIMEOUT');
}
async function fixture(t, { hosted = false, extension } = {}) {
  const dir = await fs.mkdtemp('/tmp/pi-companion-life-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [{ folder: cwd, list: true, read: true, send: true }],
  };
  config.piArgs.push(
    '-e',
    path.resolve('test/fixtures/faux-extension.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  );
  const file = path.join(dir, 'owner.json');
  await fs.writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const previous = [process.env.PI_MCP_OWNER_CONFIG, process.env.PI_MCP_ATTACH_DIR];
  process.env.PI_MCP_OWNER_CONFIG = file;
  process.env.PI_MCP_ATTACH_DIR = config.attachmentDir;
  const finishers = [],
    errors = [];
  let runtime, controller;
  const bridge = await new Bridge(config).init();
  t.after(async () => {
    for (const finish of finishers) finish();
    await runtime?.session.abort();
    await runtime?.dispose();
    await controller?.close();
    await bridge.close();
    for (const [i, name] of ['PI_MCP_OWNER_CONFIG', 'PI_MCP_ATTACH_DIR'].entries()) {
      if (previous[i] === undefined) delete process.env[name];
      else process.env[name] = previous[i];
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const a = await bridge.session((await savedSession(bridge)).session_id),
    b = await bridge.session((await savedSession(bridge)).session_id);
  if (hosted)
    controller = await reserveHostSession({ attachmentDir: config.attachmentDir, session: a });
  const faux = fauxProvider({
    provider: 'bridge-fixture',
    models: [{ id: 'deterministic' }, { id: 'other' }],
    tokensPerSecond: 10000,
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const factory = async (options) => {
    const services = await createAgentSessionServices({
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: 'Offline lifecycle test.',
        extensionFactories: [attachExtension, ...(extension ? [extension] : [])],
      },
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager: options.sessionManager,
        sessionStartEvent: options.sessionStartEvent,
        model: faux.getModel(),
        thinkingLevel: 'off',
        tools: [],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };
  runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: path.join(dir, 'agent'),
    sessionManager: SessionManager.open(a.file),
  });
  const bind = (session) =>
    session.bindExtensions({
      mode: 'tui',
      uiContext: { notify() {} },
      onError: (error) => errors.push(error),
      commandContextActions: {
        waitForIdle: () => session.waitForIdle(),
        switchSession: (...args) => runtime.switchSession(...args),
      },
    });
  runtime.setRebindSession(bind);
  await bind(runtime.session);
  const binding = hosted ? createSdkHostBinding(runtime.session) : null;
  if (controller) await controller.ready(binding);
  return { dir, config, bridge, a, b, runtime, modelRuntime, faux, finishers, binding, errors };
}

test('native replacement ignores old endpoint metadata and retains explicit pauses through reload and switch', async (t) => {
  let f,
    replaceMetadata = false;
  f = await fixture(t, {
    extension: (pi) => {
      // Run after the companion has drained and closed its old context.
      pi.on('session_shutdown', async () => {
        if (!replaceMetadata) return;
        replaceMetadata = false;
        const file = claimFile(f.config.attachmentDir, f.a);
        const old = JSON.parse(await fs.readFile(file, 'utf8'));
        await fs.writeFile(
          file,
          JSON.stringify({
            ...old,
            kind: 'unsupported-endpoint',
            generation: null,
            socket: '/unusable/endpoint',
            handoffId: 'unusable',
            noColdReacquire: true,
          }),
        );
      });
    },
  });
  const before = await readClaim(f.config.attachmentDir, f.a);
  replaceMetadata = true;
  await f.runtime.session.reload();
  const after = await readClaim(f.config.attachmentDir, f.a);
  assert.equal(after.kind, 'tui');
  assert.equal(after.phase, 'ready');
  assert.notEqual(after.generation, before.generation);
  for (const field of ['pid', 'start', 'boot'])
    assert.equal(after.owner[field], before.owner[field]);
  assert.equal(after.noColdReacquire, true);
  assert.equal(after.handoffId, undefined);
  assert.deepEqual(f.errors, []);
  assert.equal((await f.bridge.read({ session_id: f.a.id })).view, 'session');
  await f.runtime.switchSession(f.b.file);
  const pause = await readClaim(f.config.attachmentDir, f.a);
  assert.equal(pause.owner, null);
  assert.equal(pause.phase, 'released');
  assert.equal(pause.noColdReacquire, true);
});

test('native UI rebinding retains the active writer endpoint', async (t) => {
  const f = await fixture(t);
  const before = await readClaim(f.config.attachmentDir, f.a);
  await f.runtime.session.bindExtensions({ uiContext: { notify() {} } });
  assert.deepEqual(await readClaim(f.config.attachmentDir, f.a), before);
  assert.equal((await f.bridge.read({ session_id: f.a.id })).view, 'session');
  assert.deepEqual(f.errors, []);
});

test('accepted companion completion survives same-process session replacement and keeps its original leaf', async (t) => {
  const f = await fixture(t);
  f.faux.setResponses([
    fauxAssistantMessage('ORIGINAL_SESSION_RESULT'),
    fauxAssistantMessage('REPLACEMENT_SESSION_RESULT'),
  ]);
  const attempts = [];
  let releaseDelivery;
  const gate = new Promise((resolve) => {
    releaseDelivery = resolve;
  });
  f.finishers.push(releaseDelivery);
  f.bridge.events.retryDelays = [0];
  f.bridge.events.post = async (_url, body) => {
    const event = JSON.parse(body);
    if (event.type === 'verification')
      return { status: 200, body: JSON.stringify({ challenge: event.challenge }) };
    attempts.push(body);
    if (attempts.length === 1) {
      await gate;
      return { status: 503, body: '' };
    }
    return { status: 204, body: '' };
  };
  const subscribe = (session) =>
    f.bridge.events.handle('events/subscribe', {
      name: 'session.settled',
      arguments: { session_id: session.id },
      delivery: {
        mode: 'webhook',
        url: 'https://callback.example/companion-lifecycle',
        secret: 'whsec_' + Buffer.alloc(32, 6).toString('base64'),
      },
    });
  await subscribe(f.a);
  const ownerA = await readClaim(f.config.attachmentDir, f.a);
  await f.runtime.session.prompt('Finish the original session.');
  await until(() => attempts.length === 1);
  const original = JSON.parse(attempts[0]);
  assert.equal(original.data.result.text, 'ORIGINAL_SESSION_RESULT');
  await f.runtime.switchSession(f.b.file);
  const ownerB = await readClaim(f.config.attachmentDir, f.b);
  assert.equal(ownerB.owner.pid, ownerA.owner.pid);
  assert.notEqual(ownerB.generation, ownerA.generation);
  releaseDelivery();
  await until(() => attempts.length === 2 && !f.bridge.events.deliveries.size);
  assert.equal(
    attempts[1],
    attempts[0],
    'Retry preserves the accepted occurrence after replacement',
  );
  await subscribe(f.b);
  await f.runtime.session.prompt('Finish the replacement session.');
  await until(() => attempts.length === 3);
  const replacement = JSON.parse(attempts[2]);
  assert.equal(original.data.session_id, f.a.id);
  assert.equal(replacement.data.session_id, f.b.id);
  assert.equal(replacement.data.result.text, 'REPLACEMENT_SESSION_RESULT');
  const originalRead = JSON.stringify(await f.bridge.read(original.data.read));
  assert.match(originalRead, /ORIGINAL_SESSION_RESULT/);
  assert.doesNotMatch(originalRead, /REPLACEMENT_SESSION_RESULT/);
  assert.deepEqual(f.errors, []);
});

test('native resume at the same path retires only the replaced native identity', async (t) => {
  const f = await fixture(t);
  const before = await readClaim(f.config.attachmentDir, f.a);
  const header = { ...f.a.header, id: randomUUID() };
  await fs.writeFile(f.a.file, JSON.stringify(header) + '\n');
  assert.deepEqual(await f.runtime.switchSession(f.a.file), { cancelled: false });
  const current = { file: f.a.file, header };
  assert.equal(await readClaim(f.config.attachmentDir, f.a), null);
  const after = await readClaim(f.config.attachmentDir, current);
  assert.equal(after.sessionId, header.id);
  assert.equal(after.phase, 'ready');
  assert.notEqual(after.generation, before.generation);
  assert.deepEqual(f.errors, []);
});

test('native reload does not replace the same process host controller with unsupported endpoint metadata', async (t) => {
  const f = await fixture(t, { hosted: true });
  const original = await readClaim(f.config.attachmentDir, f.a);
  const file = claimFile(f.config.attachmentDir, f.a);
  const unsupported = { ...original, generation: null, socket: '/unusable/endpoint' };
  try {
    await fs.writeFile(file, JSON.stringify(unsupported));
    await f.runtime.session.reload();
    assert.deepEqual(await readClaim(f.config.attachmentDir, f.a), unsupported);
    assert.deepEqual(f.errors, []);
  } finally {
    await fs.writeFile(file, JSON.stringify(original));
  }
});

test('companion runtime contexts follow session replacement and never leak the previous session', async (t) => {
  const f = await fixture(t, {
    extension: (pi) => {
      pi.on('context', (event) => ({
        messages: [{ role: 'user', content: 'RUNTIME_SUMMARY', timestamp: 1 }, ...event.messages],
      }));
    },
  });
  const read = (target) =>
    f.bridge.read({ session_id: target.id, view: 'runtime', max_bytes: 65536 });
  assert.equal((await read(f.a)).observation.reason, 'no_observation');
  f.faux.setResponses([
    fauxAssistantMessage('FIRST_ANSWER'),
    fauxAssistantMessage('SECOND_ANSWER'),
  ]);
  await f.runtime.session.prompt('FIRST_SESSION_INPUT');
  const first = await read(f.a);
  assert.equal(first.source, 'tui');
  assert.equal(first.observation.owner_active, true);
  assert.ok(JSON.stringify(first).includes('RUNTIME_SUMMARY'));
  assert.ok(JSON.stringify(first).includes('FIRST_SESSION_INPUT'));
  assert.ok(!JSON.stringify(first.items).includes('FIRST_ANSWER'));
  await f.runtime.switchSession(f.b.file);
  const empty = await read(f.b);
  assert.equal(empty.observation.available, false);
  assert.deepEqual(empty.items, []);
  await f.runtime.session.prompt('SECOND_SESSION_INPUT');
  const second = await read(f.b);
  assert.notEqual(second.observation.owner_generation, first.observation.owner_generation);
  assert.ok(JSON.stringify(second).includes('SECOND_SESSION_INPUT'));
  assert.ok(!JSON.stringify(second).includes('FIRST_SESSION_INPUT'));
  // The first session's retained observation is still useful after switch-away.
  const retained = await read(f.a);
  assert.equal(retained.source, 'retained');
  assert.equal(retained.observation.owner_active, false);
  assert.equal(retained.observation.id, first.observation.id);
  assert.deepEqual(f.errors, []);
});

test(
  'ordinary companion RPC refuses an existing writer before native open; unowned and same-process resumes remain valid',
  { timeout: 25000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-switch-owner-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const config = {
      ...isolatedRuntime(dir),
      stateDir: path.join(dir, 'state'),
      attachmentDir: path.join(dir, 'ipc'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: cwd }],
      defaults: denyAllPermissions(),
      grants: [{ folder: cwd, read: true, send: true }],
    };
    const configFile = path.join(dir, 'owner.json');
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const bridge = await new Bridge(config, () => assert.fail('no fallback writer')).init();
    const clients = [];
    t.after(async () => {
      for (const client of clients) await client.stop();
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const saved = [];
    for (let i = 0; i < 3; i++)
      saved.push(await bridge.session((await savedSession(bridge)).session_id));
    for (const session of saved.slice(0, 2)) {
      const client = new RpcClient({
        cliPath: nativePiCli,
        cwd,
        env: {
          HOME: dir,
          PI_CODING_AGENT_DIR: config.piRuntime.agentDir,
          PI_OFFLINE: '1',
          PI_MCP_OWNER_CONFIG: configFile,
          PI_MCP_ATTACH_DIR: config.attachmentDir,
        },
        args: [
          '--session',
          session.file,
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-tools',
          '-e',
          path.resolve('test/fixtures/faux-extension.mjs'),
          '-e',
          path.resolve('src/attach-extension.mjs'),
        ],
        provider: 'bridge-fixture',
        model: 'deterministic',
      });
      clients.push(client);
      await client.start();
      await client.getState();
    }
    const [a, b, c] = saved,
      [first, second] = clients;
    const claimA = await readClaim(config.attachmentDir, a),
      claimB = await readClaim(config.attachmentDir, b),
      before = await fs.readFile(b.file);
    assert.ok(claimA, first.getStderr());
    assert.ok(claimB, second.getStderr());
    assert.notEqual(claimA.owner.pid, claimB.owner.pid);
    const alias = path.join(dir, 'sessions', 'alias.jsonl');
    await fs.symlink(b.file, alias);
    for (const target of [
      alias,
      b.file,
      path.relative(cwd, b.file),
      '~/' + path.relative(dir, b.file),
      pathToFileURL(b.file).href,
    ]) {
      assert.deepEqual(await first.switchSession(target), { cancelled: true });
      assert.equal((await first.getState()).sessionFile, a.file);
      assert.equal((await second.getState()).sessionFile, b.file);
    }
    assert.deepEqual(await fs.readFile(b.file), before);
    assert.equal((await readClaim(config.attachmentDir, a)).generation, claimA.generation);
    assert.equal((await readClaim(config.attachmentDir, b)).generation, claimB.generation);
    for (const [client, session, text] of [
      [first, a, 'AFTER_REFUSAL_A'],
      [second, b, 'STILL_USABLE_B'],
    ]) {
      await client.prompt(text);
      await until(async () => {
        const messages = await client.getMessages();
        return messages.at(-1)?.role === 'assistant' && !(await client.getState()).isStreaming;
      });
      const view = await bridge.read({
        session_id: session.id,
        range: { recent: -1 },
        content: ALL_CONTENT,
      });
      assert.ok(JSON.stringify(view.items).includes(text));
    }
    assert.ok(!(await fs.readFile(b.file, 'utf8')).includes('AFTER_REFUSAL_A'));
    assert.deepEqual(await first.switchSession(c.file), { cancelled: false });
    assert.equal((await first.getState()).sessionFile, c.file);
    assert.equal(await readClaim(config.attachmentDir, a), null);
    assert.deepEqual(await first.switchSession(c.file), { cancelled: false });
    assert.equal((await readClaim(config.attachmentDir, c)).owner.pid, claimA.owner.pid);
  },
);

for (const allowed of [true, false])
  for (const disconnect of [false, true])
    test(
      'companion switch drains native auth ' +
        (allowed ? 'success' : 'refusal') +
        (disconnect ? ' after client disconnect' : ' with an attached client'),
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t),
          entered = Promise.withResolvers(),
          auth = Promise.withResolvers();
        f.finishers.push(() => auth.resolve(false));
        const nativeAuth = f.modelRuntime.checkAuth.bind(f.modelRuntime);
        let calls = 0;
        t.mock.method(f.modelRuntime, 'checkAuth', async (provider) => {
          if (++calls === 1) {
            entered.resolve();
            return auth.promise;
          }
          return nativeAuth(provider);
        });
        const claim = await readClaim(f.config.attachmentDir, f.a);
        let selection, socket;
        if (disconnect) {
          socket = net.createConnection(claim.socket);
          await new Promise((resolve, reject) => {
            socket.once('connect', resolve);
            socket.once('error', reject);
          });
          socket.write(
            JSON.stringify({
              generation: claim.generation,
              file: f.a.file,
              sessionId: f.a.header.id,
              op: 'set_model',
              body: { model: { provider: 'bridge-fixture', id: 'other' } },
            }) + '\n',
          );
        } else
          selection = f.bridge
            .set_model({
              session_id: f.a.id,
              model: { provider: 'bridge-fixture', id: 'other' },
            })
            .catch((error) => ({ error: error.message }));
        await entered.promise;
        assert.equal(
          (await f.bridge.list({ session_id: f.a.id })).sessions[0].status.state,
          'busy',
        );
        socket?.destroy();
        const old = f.runtime.session;
        let switched = false;
        const switching = f.runtime.switchSession(f.b.file).then((value) => {
          switched = true;
          return value;
        });
        f.finishers.push(() => socket?.destroy());
        await until(
          async () => (await readClaim(f.config.attachmentDir, f.a))?.phase === 'transitioning',
        );
        assert.equal(switched, false);
        assert.equal(f.runtime.session, old);
        const refused = await f.bridge.send({
          session_id: f.a.id,
          text: 'MUST_NOT_OPEN_SECOND_WRITER',
        });
        assert.equal(refused.status, 'rejected', JSON.stringify(refused));
        assert.ok(await readClaim(f.config.attachmentDir, f.a));
        assert.ok(![...f.bridge.pool.instances.values()].some((r) => !r.attached));
        assert.ok(!(await fs.readFile(f.a.file, 'utf8')).includes('MUST_NOT_OPEN_SECOND_WRITER'));
        auth.resolve(allowed);
        assert.deepEqual(await switching, { cancelled: false });
        await selection;
        assert.equal(calls, 1);
        assert.equal(await readClaim(f.config.attachmentDir, f.a), null);
        const entries = SessionManager.open(f.a.file).getEntries();
        assert.equal(
          entries.some((e) => e.type === 'model_change' && e.modelId === 'other'),
          allowed,
        );
        const sent = await f.bridge.send({ session_id: f.a.id, text: 'AFTER_SWITCH' });
        assert.equal(sent.status, 'started', JSON.stringify(sent));
        await until(() => !f.bridge.pool.get(f.a.id) && !f.bridge.autoReleases.size);
        const current = await f.bridge.read({
          session_id: f.a.id,
          range: { recent: -1 },
          content: ALL_CONTENT,
        });
        assert.ok(JSON.stringify(current.items).includes('AFTER_SWITCH'));
        assert.ok(current.items.some((e) => e.type === 'assistant'));
        assert.deepEqual(f.errors, []);
      },
    );

for (const outcome of ['handled', 'rejected'])
  test(
    'SDK idle_only respects native prompt preflight until ' + outcome,
    { timeout: 15000 },
    async (t) => {
      const entered = Promise.withResolvers(),
        finish = Promise.withResolvers();
      const f = await fixture(t, {
        hosted: true,
        extension: (pi) =>
          pi.on('input', async (event) => {
            if (event.text !== 'FIRST_PREFLIGHT') return;
            entered.resolve();
            await finish.promise;
            if (outcome === 'rejected') throw new Error('SYNTHETIC_INPUT_REJECTION');
            return { action: 'handled' };
          }),
      });
      f.finishers.push(() => finish.resolve());
      assert.equal(
        (await f.bridge.send({ session_id: f.a.id, text: 'FIRST_PREFLIGHT' })).status,
        'dispatched',
      );
      await entered.promise;
      const session = f.runtime.session;
      assert.equal(session.isIdle, true);
      assert.equal(session.pendingMessageCount, 0);
      const entries = structuredClone(session.sessionManager.getEntries()),
        calls = f.faux.state.callCount;
      const skipped = await f.bridge.send({
        session_id: f.a.id,
        text: 'SECOND_IDLE_ONLY',
        mode: 'idle_only',
      });
      assert.match(skipped.submission_id, /^[a-f0-9-]{36}$/);
      assert.deepEqual(skipped, {
        status: 'skipped',
        reason: 'busy',
        submission_id: skipped.submission_id,
      });
      assert.deepEqual(session.sessionManager.getEntries(), entries);
      assert.equal(f.faux.state.callCount, calls);
      finish.resolve();
      await until(async () => (await f.binding.state()).isIdle);
      assert.equal(
        (
          await f.bridge.send({
            session_id: f.a.id,
            text: 'AFTER_PREFLIGHT',
            mode: 'idle_only',
          })
        ).status,
        'dispatched',
      );
      await until(() => f.faux.state.callCount > calls && session.isIdle);
      const current = await f.bridge.read({
        session_id: f.a.id,
        range: { recent: -1 },
        content: ALL_CONTENT,
      });
      assert.ok(JSON.stringify(current.items).includes('AFTER_PREFLIGHT'));
      assert.ok(!JSON.stringify(current.items).includes('SECOND_IDLE_ONLY'));
    },
  );
