import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
  InMemoryCredentialStore,
} from './fixtures/pi.mjs';
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { loadSavedSession } from '../src/data.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-ext-read-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
  };
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge),
    saved = await bridge.session(made.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, cwd, config, bridge, saved, id: made.session_id };
}
async function sdk(t, f, factory, expectedCalls = 0, tools = []) {
  const manager = SessionManager.open(f.saved.file),
    old = manager.appendMessage({ role: 'user', content: 'PUBLIC_OLD', timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage('PUBLIC_PRIOR_REPLY'));
  const kept = manager.appendMessage({ role: 'user', content: 'PUBLIC_KEPT', timestamp: 2 });
  const settings = SettingsManager.inMemory({
    cacheWarming: 'off',
    compaction: { enabled: false, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: f.cwd,
    agentDir: path.join(f.dir, 'agent'),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: 'Public offline fixture.',
    extensionFactories: [(pi) => factory(pi, { old, kept })],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const faux = fauxProvider({ provider: 'read-fixture' }),
    modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
  modelRuntime.registerNativeProvider(faux.provider);
  const { session } = await createAgentSession({
    cwd: f.cwd,
    agentDir: path.join(f.dir, 'agent'),
    modelRuntime,
    model: faux.getModel(),
    thinkingLevel: 'off',
    tools,
    resourceLoader: loader,
    sessionManager: manager,
    settingsManager: settings,
  });
  const errors = [];
  await session.bindExtensions({ mode: 'rpc', onError: (e) => errors.push(e) });
  t.after(() => {
    session.dispose();
    assert.deepEqual(errors, []);
    assert.equal(
      faux.state.callCount,
      expectedCalls,
      'Only explicitly scripted offline provider calls may occur',
    );
  });
  return { session, manager, old, kept, faux };
}

test('original custom compaction hook preserves native summary, retained boundary and raw provenance', async (t) => {
  const f = await fixture(t);
  let compactCalls = 0;
  const { session, manager, kept, old } = await sdk(t, f, (pi, ids) =>
    pi.on('session_before_compact', (event) => {
      compactCalls++;
      return {
        compaction: {
          summary: 'PUBLIC_EXTENSION_CHECKPOINT',
          firstKeptEntryId: ids.kept,
          tokensBefore: event.preparation.tokensBefore,
          details: { fixture: true },
        },
      };
    }),
  );
  await session.compact();
  assert.equal(compactCalls, 1);
  const entry = manager.getEntries().find((e) => e.type === 'compaction');
  assert.equal(entry.fromHook, true);
  const context = await f.bridge.read({ session_id: f.id, preset: 'recent' });
  const parts = context.items.find((x) => x.type === 'summary').parts;
  assert.equal(parts[0].source.entry_id, entry.id);
  assert.equal(parts[0].message.summary, 'PUBLIC_EXTENSION_CHECKPOINT');
  assert.ok(JSON.stringify(context).includes('PUBLIC_KEPT'));
  assert.ok(!JSON.stringify(context).includes('PUBLIC_OLD'));
  const raw = await loadSavedSession(f.saved);
  assert.equal(raw.entries.find((x) => x.id === entry.id).firstKeptEntryId, kept);
  assert.equal(raw.entries.find((x) => x.id === entry.id).fromHook, true);
  assert.ok(raw.entries.some((x) => x.id === old));
  assert.equal(compactCalls, 1, 'Reads do not rerun compaction hooks');
});
test('display-hidden custom messages remain projected while custom extension state is raw-only', async (t) => {
  const f = await fixture(t);
  await sdk(t, f, (pi) =>
    pi.on('session_start', async (_event, ctx) => {
      pi.appendEntry('fixture-state', { marker: 'PUBLIC_CUSTOM_STATE' });
      pi.sendMessage(
        { customType: 'fixture-hidden', content: 'PUBLIC_HIDDEN_MESSAGE', display: false },
        { triggerTurn: false },
      );
    }),
  );
  const context = await f.bridge.read({ session_id: f.id, preset: 'full' }),
    raw = await loadSavedSession(f.saved);
  assert.ok(
    context.items.some(
      (x) =>
        x.message?.role === 'custom' &&
        x.message.display === false &&
        x.message.content === 'PUBLIC_HIDDEN_MESSAGE',
    ),
  );
  assert.ok(!JSON.stringify(context).includes('PUBLIC_CUSTOM_STATE'));
  assert.ok(JSON.stringify(raw).includes('PUBLIC_CUSTOM_STATE'));
  assert.ok(raw.entries.some((x) => x.type === 'custom_message' && x.display === false));
  f.config.grants.push({ session_id: f.id, read: false });
  await assert.rejects(f.bridge.read({ session_id: f.id, preset: 'full' }), /NOT_FOUND_OR_DENIED/);
});
test('request-time filtering differs from saved projection; reads neither replay hooks nor call a provider', async (t) => {
  const f = await fixture(t);
  let contextCalls = 0,
    beforeCalls = 0;
  const { session, faux } = await sdk(
    t,
    f,
    (pi) => {
      pi.on('session_start', async (_event, ctx) => {
        pi.sendMessage(
          { customType: 'fixture-plan', content: 'PUBLIC_OLD_PLAN', display: false },
          { triggerTurn: false },
        );
      });
      pi.on('context', (event) => {
        contextCalls++;
        return { messages: event.messages.filter((m) => m.customType !== 'fixture-plan') };
      });
      pi.on('before_agent_start', () => {
        beforeCalls++;
        return { systemPrompt: 'PUBLIC_FORCED_MEMORY' };
      });
    },
    1,
  );
  const fileBefore = await fs.readFile(f.saved.file, 'utf8'),
    readBefore = await f.bridge.read({ session_id: f.id, preset: 'full' });
  assert.ok(JSON.stringify(readBefore).includes('PUBLIC_OLD_PLAN'));
  assert.equal(contextCalls, 0);
  assert.equal(beforeCalls, 0);
  // Capture through the public faux-provider response factory. Never replace
  // Pi methods: the real SDK runs its normal preparation and persistence.
  let requestMessages;
  faux.setResponses([
    (context) => {
      requestMessages = context.messages;
      return fauxAssistantMessage('PUBLIC_OFFLINE_REPLY');
    },
  ]);
  await session.prompt('PUBLIC_FIXTURE_PROMPT');
  assert.equal(contextCalls, 1);
  assert.equal(beforeCalls, 1);
  assert.ok(!JSON.stringify(requestMessages).includes('PUBLIC_OLD_PLAN'));
  assert.equal(requestMessages[0].role, 'system');
  assert.equal(requestMessages[0].content, 'PUBLIC_FORCED_MEMORY');
  const afterPrompt = await fs.readFile(f.saved.file, 'utf8');
  assert.notEqual(afterPrompt, fileBefore);
  const readAfter = await f.bridge.read({ session_id: f.id, preset: 'full' });
  assert.ok(JSON.stringify(readAfter).includes('PUBLIC_OLD_PLAN'));
  assert.ok(!JSON.stringify(readAfter).includes('PUBLIC_FORCED_MEMORY'));
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), afterPrompt);
  assert.equal(contextCalls, 1);
  assert.equal(beforeCalls, 1);
});
test('selected agentDir discovers extensions; an explicit disable flag remains authoritative', async (t) => {
  const f = await fixture(t),
    agentDir = path.join(f.dir, 'owner-agent'),
    extensions = path.join(agentDir, 'extensions');
  await fs.mkdir(extensions, { recursive: true });
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const extension = path.join(extensions, 'original-fixture.js');
  await fs.writeFile(
    extension,
    "export default function(pi){pi.on('session_start',()=>pi.appendEntry('profile-marker',{loaded:true}));}",
  );
  f.config.piRuntime = { agentDir, inheritEnv: [] };
  let rpc;
  try {
    rpc = await new PiRpc(f.config, f.saved).start();
    assert.ok((await rpc.entries()).entries.some((x) => x.customType === 'profile-marker'));
    await rpc.stop();
    // Use a new native file so a previous persisted marker cannot mask discovery.
    const made = await savedSession(f.bridge),
      saved = await f.bridge.session(made.session_id);
    f.config.piArgs = ['--offline', '--no-extensions'];
    rpc = await new PiRpc(f.config, saved).start();
    assert.ok(!(await rpc.entries()).entries.some((x) => x.customType === 'profile-marker'));
    await rpc.stop();
    f.config.piArgs = ['--offline', '--no-extensions', '-e', extension];
    rpc = await new PiRpc(f.config, saved).start();
    assert.ok((await rpc.entries()).entries.some((x) => x.customType === 'profile-marker'));
  } finally {
    await rpc?.stop();
  }
});

test('real nested tool failure remains visible under its successful outer tool in a read-only native projection', async (t) => {
  const f = await fixture(t);
  const { session, faux, manager } = await sdk(
    t,
    f,
    (pi) => {
      pi.registerTool({
        name: 'inner_failure',
        exposure: 'deferred',
        label: 'Inner',
        description: 'Native nested failure',
        parameters: { type: 'object', properties: {} },
        async execute() {
          throw new Error('NESTED_REAL_FAILURE');
        },
      });
      pi.registerTool({
        name: 'outer_success',
        label: 'Outer',
        description: 'Native outer success',
        parameters: { type: 'object', properties: {} },
        async execute(_id, _params, _signal, _update, ctx) {
          const result = await ctx.executeTool('inner_failure', {});
          assert.equal(result.isError, true);
          return { content: [{ type: 'text', text: 'OUTER_SUCCESS' }], details: {} };
        },
      });
      pi.on('session_start', () => pi.setActiveTools(['outer_success']));
    },
    2,
    ['outer_success', 'inner_failure'],
  );
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('outer_success', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('NESTED_FINISHED'),
  ]);
  await session.prompt('RUN_NESTED');
  const raw = manager.getEntries().find((e) => e.message?.role === 'toolResult').message;
  assert.equal(raw.isError, false, JSON.stringify(raw));
  assert.equal(raw.nestedCalls.calls[0].status, 'error');
  assert.match(raw.nestedCalls.calls[0].error, /NESTED_REAL_FAILURE/);
  const read = await f.bridge.read({ session_id: f.id, preset: 'full' });
  const outer = read.items.find((u) => u.type === 'tool_result').message;
  assert.equal(outer.isError, false);
  assert.deepEqual(outer.nestedCalls, raw.nestedCalls);
});
