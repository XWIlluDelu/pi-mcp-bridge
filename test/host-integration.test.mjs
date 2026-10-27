import packageInfo from '../package.json' with { type: 'json' };
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from './fixtures/pi.mjs';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  RpcClient,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { processIdentity, readClaim } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';
import attachExtension from './fixtures/companion.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(fn) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('HOST_FIXTURE_TIMEOUT');
}
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-host-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
    attachmentDir: path.join(dir, 'ipc'),
  };
  let spawned = 0;
  const bridge = await new Bridge(config, async () => {
    spawned++;
    throw new Error('UNEXPECTED_BRIDGE_SPAWN');
  }).init();
  const controllers = [],
    cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    for (const controller of controllers) await controller.close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const create = async (key) => {
    const made = await savedSession(bridge);
    return bridge.session(made.session_id);
  };
  return { dir, cwd, config, bridge, create, controllers, cleanups, spawned: () => spawned };
}

test('official host-owned Pi RPC serves bridge reads and sends without spawning; timed-out replies do not redispatch', async (t) => {
  const f = await fixture(t),
    saved = await f.create('rpc-seed'),
    pidFile = path.join(f.dir, 'writer-pid.json');
  const extension = path.join(f.dir, 'pid-extension.mjs');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs';export default function(){fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(process.pid));}`,
  );
  const client = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.cwd,
    env: { HOME: f.dir, PI_CODING_AGENT_DIR: path.join(f.dir, 'agent'), PI_OFFLINE: '1' },
    provider: 'bridge-fixture',
    model: 'deterministic',
    args: [
      '--no-session',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-tools',
      '-e',
      path.join(base, 'test/fixtures/faux-extension.mjs'),
      '-e',
      path.join(base, 'test/fixtures/model-provider.mjs'),
      '-e',
      extension,
    ],
  });
  const agentDir = path.join(f.dir, 'agent');
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      defaultThinkingLevel: 'low',
      modelThinkingLevels: { 'model-fixture/reasoner': 'medium' },
    }),
  );
  f.cleanups.push(() => client.stop());
  await client.start();
  await client.getState();
  const pid = JSON.parse(await fs.readFile(pidFile, 'utf8')),
    owner = await processIdentity(pid);
  assert.notEqual(pid, process.pid);
  const controller = await reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: f.config.attachmentDir,
    session: saved,
    owner,
  });
  f.controllers.push(controller);
  await client.switchSession(saved.file);
  const binding = createRpcHostBinding(client),
    gate = deferred();
  let submissions = 0;
  f.cleanups.unshift(() => gate.resolve());
  await controller.ready({
    ...binding,
    submit: async (args) => {
      submissions++;
      const result = await binding.submit(args);
      if (args.text === 'PUBLIC_DELAYED_REPLY') await gate.promise;
      return result;
    },
  });
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: saved.id,
      model: { provider: 'model-fixture', id: 'vision' },
      thinking_level: 'high',
    }),
    { model: { provider: 'model-fixture', id: 'vision' }, thinking_level: 'high' },
  );
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: saved.id,
      model: { provider: 'model-fixture', id: 'reasoner' },
    }),
    { model: { provider: 'model-fixture', id: 'reasoner' }, thinking_level: 'high' },
  );
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: saved.id,
      model: { provider: 'bridge-fixture', id: 'deterministic' },
    }),
    { model: { provider: 'bridge-fixture', id: 'deterministic' }, thinking_level: 'off' },
  );
  const first = await f.bridge.send({
    session_id: saved.id,

    text: 'PUBLIC_RPC_INPUT',
  });
  assert.ok(['started', 'queued', 'handled'].includes(first.status), JSON.stringify(first));
  assert.equal(submissions, 1);
  await until(async () => !(await client.getState()).isStreaming);
  const raw = await f.bridge.read({ session_id: saved.id });
  assert.match(JSON.stringify(raw), /PUBLIC_RPC_INPUT/);
  assert.equal((await readClaim(f.config.attachmentDir, saved)).owner.pid, pid);
  assert.equal(f.spawned(), 0);
  ackTimeout(t, ['send']);
  const delayedArgs = {
    session_id: saved.id,

    text: 'PUBLIC_DELAYED_REPLY',
  };
  const delayed = await f.bridge.send(delayedArgs);
  assert.equal(delayed.status, 'unknown');
  assert.equal(submissions, 2);

  assert.equal(submissions, 2);
  gate.resolve();
  await until(async () => !(await client.getState()).isStreaming);
  const entries = await client.getEntries();
  assert.equal(
    entries.entries.filter(
      (e) =>
        e.message?.role === 'user' &&
        JSON.stringify(e.message.content).includes('PUBLIC_DELAYED_REPLY'),
    ).length,
    1,
  );
  // Losing the controller endpoint cannot turn a surviving child into a cold
  // session. Keep its exact owner claim and refuse bridge-managed fallback.
  await controller.close();
  assert.ok(await processIdentity(pid));
  await assert.rejects(f.bridge.read({ session_id: saved.id }));
  const unreachable = await f.bridge.send({
    session_id: saved.id,

    text: 'MUST_NOT_DISPATCH',
  });
  assert.equal(unreachable.status, 'rejected');
  assert.equal(f.spawned(), 0);
  assert.equal(submissions, 2);
  assert.equal((await readClaim(f.config.attachmentDir, saved)).owner.pid, pid);
  assert.equal((await client.getState()).sessionId, saved.header.id);
  const deleted = await f.bridge.delete({ session_id: saved.id });
  assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
  await assert.rejects(fs.stat(saved.file), { code: 'ENOENT' });
  assert.equal(f.spawned(), 0);
});

test('SDK host reload refreshes native resources, preserves history and keeps its neighboring session usable', async (t) => {
  const f = await fixture(t),
    saved = [await f.create('reload'), await f.create('neighbor')],
    inputEntered = deferred(),
    inputRelease = deferred(),
    reloadEntered = deferred(),
    reloadRelease = deferred();
  const faux = fauxProvider({ provider: 'host-reload-fixture' });
  faux.setResponses([
    fauxAssistantMessage('BEFORE_RELOAD'),
    fauxAssistantMessage('AFTER_RELOAD'),
    fauxAssistantMessage('NEIGHBOR_STILL_USABLE'),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const sessions = [],
    loads = [0, 0],
    starts = [0, 0],
    errors = [];
  f.cleanups.push(async () => {
    inputRelease.resolve();
    reloadRelease.resolve();
    for (const session of sessions) {
      await session.abort();
      session.dispose();
    }
  });
  for (let index = 0; index < saved.length; index++) {
    const controller = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: saved[index],
    });
    f.controllers.push(controller);
    const agentDir = path.join(f.dir, 'reload-agent-' + index),
      settings = SettingsManager.inMemory({
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      });
    const loader = new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: 'Isolated native reload fixture.',
      extensionFactories: [
        (pi) => {
          pi.registerProvider(faux.provider);
          pi.registerCommand('resource_' + ++loads[index], { handler: async () => {} });
          pi.on('session_start', () => {
            starts[index]++;
          });
          pi.on('input', async (event) => {
            if (event.text !== 'HOLD_LOCAL_INPUT') return;
            inputEntered.resolve();
            await inputRelease.promise;
            return { action: 'handled' };
          });
          pi.on('session_shutdown', async (event) => {
            if (event.reason !== 'reload') return;
            reloadEntered.resolve();
            await reloadRelease.promise;
          });
        },
      ],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.open(saved[index].file),
      settingsManager: settings,
    });
    sessions.push(session);
    await controller.ready(createSdkHostBinding(session));
    await session.bindExtensions({ mode: 'rpc', onError: (error) => errors.push(error) });
  }
  const [session, neighbor] = sessions,
    beforeClaims = await Promise.all(saved.map((item) => readClaim(f.config.attachmentDir, item)));
  await session.prompt('PRESERVE_THIS_HISTORY');
  const before = structuredClone(session.sessionManager.getEntries()),
    neighborBefore = structuredClone(neighbor.sessionManager.getEntries());
  const preparing = session.prompt('HOLD_LOCAL_INPUT');
  await inputEntered.promise;
  assert.equal(session.isIdle, true); // Native streaming state alone misses this work.
  assert.deepEqual(await f.bridge.reload({ session_id: saved[0].id }), {
    status: 'rejected',
    reason: 'RELOAD_BUSY',
  });
  assert.deepEqual(loads, [1, 1]);
  inputRelease.resolve();
  await preparing;
  const reloading = f.bridge.reload({ session_id: saved[0].id });
  await reloadEntered.promise;
  await assert.rejects(session.prompt('MUST_NOT_ENTER'), /RELOAD_IN_PROGRESS/);
  reloadRelease.resolve();
  assert.deepEqual(await reloading, {
    status: 'completed',
    owner_version: packageInfo.version,
    read_compatible: true,
  });
  assert.deepEqual(loads, [2, 1]);
  assert.deepEqual(starts, [2, 1]);
  assert.deepEqual(session.sessionManager.getEntries(), before);
  assert.deepEqual(neighbor.sessionManager.getEntries(), neighborBefore);
  assert.deepEqual(
    await Promise.all(saved.map((item) => readClaim(f.config.attachmentDir, item))),
    beforeClaims,
  );
  const commands = session.extensionRunner.getRegisteredCommands().map((command) => command.name);
  assert.ok(commands.includes('resource_2'));
  assert.ok(!commands.includes('resource_1'));
  assert.equal(
    (await f.bridge.send({ session_id: saved[0].id, text: 'CONTINUE_RELOADED' })).status,
    'dispatched',
  );
  await until(() => JSON.stringify(session.sessionManager.getEntries()).includes('AFTER_RELOAD'));
  await neighbor.prompt('CONTINUE_NEIGHBOR');
  assert.match(
    JSON.stringify(await f.bridge.read({ session_id: saved[1].id })),
    /NEIGHBOR_STILL_USABLE/,
  );
  assert.deepEqual(errors, []);
  assert.equal(f.spawned(), 0);
});

test('two official SDK sessions in one host PID release independently without shutting down their neighbor', async (t) => {
  const f = await fixture(t),
    savedA = await f.create('sdk-a'),
    savedB = await f.create('sdk-b');
  const faux = fauxProvider({
    provider: 'host-sdk-fixture',
    models: [
      { id: 'a', reasoning: false, input: ['text'] },
      { id: 'b', reasoning: true, input: ['text'] },
      { id: 'c', reasoning: true, input: ['text'] },
    ],
  });
  faux.setResponses([
    fauxAssistantMessage('PUBLIC_A_REPLY'),
    fauxAssistantMessage('PUBLIC_B_REPLY'),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const hosts = [];
  for (const saved of [savedA, savedB]) {
    const controller = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: saved,
    });
    f.controllers.push(controller);
    const agentDir = path.join(f.dir, saved === savedA ? 'agent-a' : 'agent-b'),
      settings = SettingsManager.inMemory({
        defaultThinkingLevel: 'low',
        modelThinkingLevels: { 'host-sdk-fixture/c': 'medium' },
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      });
    const loader = new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: 'Public offline host fixture.',
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir,
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.open(saved.file),
      settingsManager: settings,
    });
    let released = 0;
    f.cleanups.push(async () => {
      await session.abort();
      session.dispose();
    });
    await controller.ready(
      createSdkHostBinding(session, {
        release: async () => {
          await session.abort();
          session.dispose();
          released++;
          return { released: true };
        },
      }),
    );
    hosts.push({
      session,
      get released() {
        return released;
      },
    });
  }
  const claimA = await readClaim(f.config.attachmentDir, savedA),
    claimB = await readClaim(f.config.attachmentDir, savedB);
  assert.equal(claimA.owner.pid, process.pid);
  assert.equal(claimB.owner.pid, process.pid);
  assert.notEqual(claimA.generation, claimB.generation);
  const neighbor = { model: hosts[1].session.model, level: hosts[1].session.thinkingLevel };
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: savedA.id,
      model: { provider: 'host-sdk-fixture', id: 'b' },
      thinking_level: 'high',
    }),
    {
      model: { provider: hosts[0].session.model.provider, id: hosts[0].session.model.id },
      thinking_level: 'high',
    },
  );
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: savedA.id,
      model: { provider: 'host-sdk-fixture', id: 'c' },
    }),
    { model: { provider: 'host-sdk-fixture', id: 'c' }, thinking_level: 'high' },
  );
  assert.deepEqual(
    await f.bridge.set_model({
      session_id: savedA.id,
      model: { provider: 'host-sdk-fixture', id: 'a' },
    }),
    { model: { provider: 'host-sdk-fixture', id: 'a' }, thinking_level: 'off' },
  );
  assert.equal(hosts[1].session.model, neighbor.model);
  assert.equal(hosts[1].session.thinkingLevel, neighbor.level);
  assert.equal(faux.state.callCount, 0);
  assert.equal(hosts[0].released, 0);
  assert.equal(hosts[1].released, 0);
  // A local owner changes model after the first reduced state observation.
  // Thinking-only must not feed that old identity-only value to SDK setModel.
  const session = hosts[0].session,
    models = modelRuntime.getAvailableSnapshot();
  const fullA = models.find((m) => m.id === 'a'),
    fullB = models.find((m) => m.id === 'b');
  await session.setModel(fullA);
  const setter = t.mock.method(session, 'setModel', session.setModel.bind(session));
  let switched = false;
  Object.defineProperty(session, 'isIdle', {
    configurable: true,
    get() {
      if (!switched) {
        switched = true;
        session.agent.state.model = fullB;
      }
      return true;
    },
  });
  const binding = createSdkHostBinding(session);
  try {
    assert.deepEqual(
      await binding.setModel({
        sessionFile: savedA.file,
        sessionId: savedA.header.id,
        thinking_level: 'high',
      }),
      { model: { provider: fullB.provider, id: fullB.id }, thinking_level: 'high' },
    );
    assert.equal(setter.mock.calls.length, 0);
    assert.equal(session.model, fullB);
    assert.ok(Number.isFinite(session.model.contextWindow));
    await binding.setModel({
      sessionFile: savedA.file,
      sessionId: savedA.header.id,
      model: { provider: fullA.provider, id: fullA.id },
    });
    assert.equal(setter.mock.calls.length, 1);
    assert.deepEqual(setter.mock.calls[0].arguments[0], fullA);
    assert.deepEqual(session.model, fullA);
  } finally {
    delete session.isIdle;
  }
  const sentA = await f.bridge.send({
    session_id: savedA.id,

    text: 'PUBLIC_A_INPUT',
  });
  assert.equal(sentA.status, 'dispatched');
  await until(() => !hosts[0].session.isStreaming && faux.state.callCount === 1);
  assert.match(JSON.stringify(await f.bridge.read({ session_id: savedA.id })), /PUBLIC_A_INPUT/);
  const removed = await f.bridge.delete({ session_id: savedA.id });
  assert.equal(removed.status, 'deleted');
  assert.equal(hosts[0].released, 1);
  assert.equal(hosts[1].released, 0);
  assert.equal((await readClaim(f.config.attachmentDir, savedB)).generation, claimB.generation);
  const sentB = await f.bridge.send({
    session_id: savedB.id,

    text: 'PUBLIC_B_INPUT',
  });
  assert.equal(sentB.status, 'dispatched');
  await until(() => !hosts[1].session.isStreaming && faux.state.callCount === 2);
  assert.match(JSON.stringify(await f.bridge.read({ session_id: savedB.id })), /PUBLIC_B_INPUT/);
  assert.ok(await fs.stat(savedB.file));
  assert.equal(f.spawned(), 0);
});

test('SDK async input preparation must finish before host release permits a saved file move', async (t) => {
  const f = await fixture(t),
    saved = await f.create('sdk-preparation');
  const controller = await reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: f.config.attachmentDir,
    session: saved,
  });
  f.controllers.push(controller);
  const entered = deferred(),
    gate = deferred(),
    releasing = deferred();
  let releaseFinished = false;
  const settings = SettingsManager.inMemory({
      cacheWarming: 'off',
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
    agentDir = path.join(f.dir, 'agent-preparation');
  const loader = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt: 'Public preparation fixture.',
    extensionFactories: [
      (pi) => {
        pi.on('input', async () => {
          entered.resolve();
          await gate.promise;
          return { action: 'handled' };
        });
      },
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = fauxProvider({ provider: 'host-preparation-fixture' }),
    modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: f.cwd,
    agentDir,
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: 'off',
    tools: [],
    resourceLoader: loader,
    sessionManager: SessionManager.open(saved.file),
    settingsManager: settings,
  });
  const extensionErrors = [];
  await session.bindExtensions({ mode: 'rpc', onError: (error) => extensionErrors.push(error) });
  // The host owns all admission paths, including its own UI/router. Track the
  // public prompt promise: streaming flags alone cannot account for preparation.
  const pending = new Set();
  let accepting = true;
  const hostSession = {
    get sessionFile() {
      return session.sessionFile;
    },
    get sessionId() {
      return session.sessionId;
    },
    get sessionManager() {
      return session.sessionManager;
    },
    get isIdle() {
      return session.isIdle;
    },
    get isStreaming() {
      return session.isStreaming;
    },
    get isCompacting() {
      return session.isCompacting;
    },
    get pendingMessageCount() {
      return session.pendingMessageCount;
    },
    prompt: (text, options) => {
      if (!accepting) throw new Error('HOST_CLOSED');
      const work = session.prompt(text, options);
      pending.add(work);
      work.then(
        () => pending.delete(work),
        () => pending.delete(work),
      );
      return work;
    },
  };
  f.cleanups.unshift(async () => {
    gate.resolve();
    await Promise.allSettled([...pending]);
    await session.abort();
    session.dispose();
  });
  const preparationBinding = createSdkHostBinding(hostSession, {
    release: async () => {
      await session.abort();
      session.dispose();
      releaseFinished = true;
      return { released: true };
    },
  });
  // Host cancellation fences all its own admissions before the adapter drains
  // public preparation; writer disposal remains the final release phase.
  await controller.ready({
    ...preparationBinding,
    cancel: async () => {
      accepting = false;
      releasing.resolve();
    },
  });
  const sent = await f.bridge.send({
    session_id: saved.id,

    text: 'PUBLIC_ASYNC_PREPARATION',
  });
  assert.equal(sent.status, 'dispatched');
  await entered.promise;
  assert.equal(pending.size, 1);
  let deletionFinished = false;
  const deletion = f.bridge.delete({ session_id: saved.id }).then((value) => {
    deletionFinished = true;
    return value;
  });
  await releasing.promise;
  assert.equal(accepting, false);
  assert.equal(releaseFinished, false);
  assert.equal(deletionFinished, false);
  assert.ok(await fs.stat(saved.file));
  assert.ok(await readClaim(f.config.attachmentDir, saved));
  // Let queued I/O complete while the actual extension remains blocked.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deletionFinished, false);
  assert.ok(await fs.stat(saved.file));
  gate.resolve();
  assert.equal((await deletion).status, 'deleted');
  assert.equal(releaseFinished, true);
  await assert.rejects(fs.stat(saved.file), { code: 'ENOENT' });
  assert.equal(faux.state.callCount, 0);
  assert.deepEqual(extensionErrors, []);
  assert.equal(f.spawned(), 0);
});

for (const hosted of [true, false])
  test(
    (hosted ? 'SDK host plus companion' : 'SDK companion') +
      ' blocks remote join and pending idle-only input while preserving local commands',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        a = await f.create('a'),
        b = await f.create('b');
      f.config.grants = [{ session_id: a.id, send: true }];
      const file = path.join(f.dir, 'owner.json');
      await fs.writeFile(file, JSON.stringify(f.config), { mode: 0o600 });
      const names = ['PI_MCP_OWNER_CONFIG', 'PI_MCP_ATTACH_DIR'],
        previous = names.map((name) => process.env[name]);
      process.env.PI_MCP_OWNER_CONFIG = file;
      process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
      t.after(() =>
        names.forEach((name, i) => {
          if (previous[i] === undefined) delete process.env[name];
          else process.env[name] = previous[i];
        }),
      );
      const controller = hosted
        ? await reserveHostSession({
            buildSessionProjection: hostProjection,
            attachmentDir: f.config.attachmentDir,
            session: a,
          })
        : null;
      if (controller) f.controllers.push(controller);
      const faux = fauxProvider({ provider: 'local-control-fixture' });
      const modelRuntime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      modelRuntime.registerNativeProvider(faux.provider);
      const settings = SettingsManager.inMemory({
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      let ordinary = 0,
        switches = 0;
      const loader = new DefaultResourceLoader({
        cwd: f.cwd,
        agentDir: path.join(f.dir, 'agent'),
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) => {
            pi.registerCommand('bridge-join', { handler: async () => {} });
            pi.registerCommand('ordinary-remote', {
              handler: async () => {
                ordinary++;
              },
            });
          },
          attachExtension,
        ],
        systemPrompt: 'Offline owner-local test.',
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const { session } = await createAgentSession({
        cwd: f.cwd,
        agentDir: path.join(f.dir, 'agent'),
        modelRuntime,
        model: faux.getModel(),
        thinkingLevel: 'off',
        tools: [],
        resourceLoader: loader,
        settingsManager: settings,
        sessionManager: SessionManager.open(a.file),
      });
      f.cleanups.push(async () => {
        await session.abort();
        await session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
        session.dispose();
      });
      if (controller) await controller.ready(createSdkHostBinding(session));
      const errors = [];
      await session.bindExtensions({
        mode: 'tui',
        uiContext: { notify() {} },
        onError: (error) => errors.push(error),
        commandContextActions: {
          waitForIdle: async () => {},
          switchSession: async (file) => {
            assert.equal(file, b.file);
            switches++;
            return { cancelled: true };
          },
        },
      });
      assert.equal((await readClaim(f.config.attachmentDir, a)).kind, hosted ? 'host' : 'tui');
      const join = session.extensionRunner
        .getRegisteredCommands()
        .find(
          (c) => c.name === 'bridge-join' && c.description?.startsWith('Join a Bridge session'),
        );
      assert.ok(join);
      assert.match(join.invocationName, /^bridge-join:\d+$/);
      for (const command of ['bridge-join', join.invocationName]) {
        const result = await f.bridge.send({ session_id: a.id, text: '/' + command + ' ' + b.id });
        assert.equal(result.status, 'rejected', JSON.stringify(result));
        assert.equal(result.reason, 'OWNER_LOCAL_COMMAND_REQUIRED');
        assert.equal(await readClaim(f.config.attachmentDir, b), null);
        assert.equal(switches, 0);
        assert.equal(session.sessionId, a.header.id);
      }
      assert.equal(
        (await f.bridge.send({ session_id: a.id, text: '/ordinary-remote' })).status,
        'dispatched',
      );
      await until(() => ordinary === 1);
      await session.prompt('/' + join.invocationName + ' ' + b.id);
      assert.equal(switches, 1);
      assert.equal(session.sessionId, a.header.id);
      assert.deepEqual(errors, []);
      assert.equal(faux.state.callCount, 0);
      const started = Promise.withResolvers();
      faux.setResponses([
        async (_context, options) => {
          started.resolve();
          await new Promise((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener('abort', resolve, { once: true });
          });
          return fauxAssistantMessage('ABORTED_RESPONSE');
        },
      ]);
      const running = session.prompt('FIRST_PENDING');
      await started.promise;
      await session.followUp('USER_PENDING_FOLLOWUP');
      await session.abort();
      await running.catch(() => {});
      assert.equal(session.isIdle, true);
      assert.equal(session.pendingMessageCount, 1);
      const entries = structuredClone(session.sessionManager.getEntries()),
        calls = faux.state.callCount;
      const idle = await f.bridge.send({
        session_id: a.id,
        text: 'BRIDGE_IDLE_ONLY',
        mode: 'idle_only',
      });
      assert.match(idle.submission_id, /^[a-f0-9-]{36}$/);
      assert.deepEqual(idle, {
        status: 'skipped',
        reason: 'busy',
        submission_id: idle.submission_id,
      });
      assert.equal(session.pendingMessageCount, 1);
      assert.equal(faux.state.callCount, calls);
      assert.deepEqual(session.sessionManager.getEntries(), entries);
      session.clearQueue();
    },
  );
