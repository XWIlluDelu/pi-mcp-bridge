import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  RpcClient,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from './fixtures/pi.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';
import { launchProfile } from '../src/rpc.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

async function attached(t, route) {
  const cleanup = [],
    f = await fixture({ after: (fn) => cleanup.push(fn) }),
    session = await f.bridge.session(f.id);
  let controller;
  if (route === 'binding')
    controller = await reserveHostSession({ attachmentDir: f.bridge.pool.attachmentDir, session });
  const client = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.cwd,
    env: {
      ...launchProfile(f.config).env,
      HOME: f.dir,
      PI_OFFLINE: '1',
      ...(route === 'companion' ? { PI_MCP_ATTACH_DIR: f.bridge.pool.attachmentDir } : {}),
    },
    args: [
      '--session',
      session.file,
      ...f.config.piArgs,
      ...(route === 'companion' ? ['-e', path.resolve('src/attach-extension.mjs')] : []),
    ],
  });
  // Before fixture cleanup: native compaction hooks must settle before closing.
  t.after(async () => {
    try {
      await fs.writeFile(f.gate, 'go');
      await controller?.close();
    } finally {
      await client.stop();
      for (const close of cleanup) await close();
    }
  });
  await client.start();
  if (controller) await controller.ready(createRpcHostBinding(client));
  await client.prompt('KEEP_HISTORY '.repeat(200));
  await until(async () => !(await client.getState()).isStreaming);
  return { ...f, client, controller };
}
for (const route of ['companion', 'binding']) {
  test(
    `${route} compaction enforces permission/admission, completes natively and redacts summary`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route),
        args = { session_id: f.id };
      assert.equal((await f.bridge.compact(args)).reason, 'COMPACT_IDLE_UNCONFIRMED');
      await f.client.prompt('HOLD_MODEL');
      await until(() => exists(f.gate + '.provider-start'));
      assert.equal((await f.bridge.compact(args)).reason, 'COMPACT_BUSY');
      assert.equal(await exists(f.gate + '.provider-aborted'), false);
      await fs.writeFile(
        f.configFile,
        JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
      );
      await assert.rejects(f.bridge.compact({ ...args, interrupt: true }), /NOT_FOUND_OR_DENIED/);
      await fs.writeFile(
        f.configFile,
        JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true, stop: true }] }),
      );
      const result = await f.bridge.compact({
        ...args,
        interrupt: true,
        instructions: 'PRIVATE_SUMMARY',
      });
      assert.equal(result.status, 'accepted', JSON.stringify(result));
      assert.equal(result.completion, 'completed');
      assert.equal(result.interrupt_requested, true);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_SUMMARY'));
      await assert.rejects(f.bridge.read(args), /NOT_FOUND_OR_DENIED/);
      const entries = (await f.client.getEntries()).entries;
      assert.equal(entries.filter((e) => e.type === 'compaction').length, 1);
      assert.ok(entries.find((e) => e.type === 'compaction').summary.includes('PRIVATE_SUMMARY'));
      assert.equal(await exists(f.gate + '.provider-aborted'), true);
    },
  );
  test(
    `${route} compaction timeout never replays and keeps its pending input fence until native completion`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route);
      const result = await f.bridge.compact({
        session_id: f.id,
        interrupt: true,
        instructions: 'HOLD_COMPACT',
        timeout_ms: 50,
      });
      assert.equal(result.status, 'unknown', JSON.stringify(result));
      await until(() => exists(f.gate + '.compact-start'));
      assert.equal(
        (await f.bridge.send({ session_id: f.id, text: 'NOT_SENT' })).reason,
        'COMPACTION_PENDING',
      );
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        0,
      );
      await fs.writeFile(f.gate, 'go');
      await until(
        async () =>
          (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length === 1,
      );
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        1,
      );
    },
  );
  test(
    `${route} native compaction cancellation has no successful receipt or summary`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route);
      const result = await f.bridge.compact({
        session_id: f.id,
        interrupt: true,
        instructions: 'CANCEL_COMPACT',
      });
      assert.equal(
        result.status,
        route === 'companion' ? 'rejected' : 'unknown',
        JSON.stringify(result),
      );
      assert.equal(result.reason, route === 'companion' ? 'PI_REJECTED' : 'HOST_COMPACT_UNCERTAIN');
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        0,
      );
    },
  );
}

test(
  'SDK binding compacts through the native session and exposes only completion metadata',
  { timeout: 10000 },
  async (t) => {
    const cleanup = [],
      f = await fixture({ after: (fn) => cleanup.push(fn) }),
      saved = await f.bridge.session(f.id),
      controller = await reserveHostSession({
        attachmentDir: f.bridge.pool.attachmentDir,
        session: saved,
      }),
      faux = fauxProvider({
        provider: 'sdk-compact',
        models: [{ id: 'offline', contextWindow: 16000, maxTokens: 2048 }],
      }),
      models = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
    models.registerNativeProvider(faux.provider);
    faux.setResponses([fauxAssistantMessage('NATIVE_REPLY'), fauxAssistantMessage('NATIVE_REPLY')]);
    const settings = SettingsManager.inMemory({
        cacheWarming: 'off',
        compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 },
        retry: { enabled: false },
      }),
      loader = new DefaultResourceLoader({
        cwd: f.cwd,
        agentDir: f.config.piRuntime.agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        systemPrompt: 'Offline compact fixture',
        extensionFactories: [
          (pi) => {
            pi.on('session_before_compact', (event) => ({
              compaction: {
                summary: 'SDK_PRIVATE_SUMMARY',
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            }));
          },
        ],
      });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir: f.config.piRuntime.agentDir,
      modelRuntime: models,
      model: faux.getModel(),
      tools: [],
      resourceLoader: loader,
      sessionManager: SessionManager.open(saved.file),
      settingsManager: settings,
    });
    t.after(async () => {
      try {
        await controller.close();
        await session.abort();
        session.dispose();
      } finally {
        for (const close of cleanup) await close();
      }
    });
    await session.bindExtensions({ mode: 'rpc' });
    await controller.ready(createSdkHostBinding(session));
    await session.prompt('KEEP_HISTORY '.repeat(200));
    await session.prompt('SECOND_HISTORY '.repeat(200));
    assert.equal((await f.bridge.compact({ session_id: f.id })).reason, 'COMPACT_IDLE_UNCONFIRMED');
    const result = await f.bridge.compact({ session_id: f.id, interrupt: true });
    assert.equal(result.status, 'accepted', JSON.stringify(result));
    assert.ok(!JSON.stringify(result).includes('SDK_PRIVATE_SUMMARY'));
    assert.equal(
      session.sessionManager.getEntries().filter((e) => e.type === 'compaction').length,
      1,
    );
  },
);
