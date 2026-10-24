import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { aiEntry } from './fixtures/pi.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from './fixtures/pi.mjs';
import {
  createAgentSession,
  createExtensionRuntime,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function configFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-integration-'));
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
  };
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { config, dir, cwd };
}
function loader() {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => 'Synthetic test.',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
  };
}

test('official Pi CLI RPC resumes a durable empty session without credentials', async (t) => {
  const f = await configFixture(t);
  const bridge = await new Bridge(f.config).init();
  let runtime;
  try {
    const made = await savedSession(bridge);
    const session = await bridge.session(made.session_id);
    runtime = await new PiRpc(f.config, session).start();
    assert.equal((await runtime.state()).isStreaming, false);
    const data = await runtime.entries();
    assert.ok(Array.isArray(data.entries));
    const persisted = (await fs.readFile(session.file, 'utf8'))
      .split('\n')
      .filter(Boolean)
      .map(JSON.parse);
    assert.equal(
      persisted.filter(
        (e) => e.type === 'message' && ['user', 'assistant'].includes(e.message.role),
      ).length,
      0,
    );
    // A prompt is deliberately not sent: this test only verifies real RPC startup/resume.
  } finally {
    await runtime?.stop();
    await bridge.close();
  }
});

test('real Pi SDK with faux provider sends, persists, reads and resumes (no real model)', async (t) => {
  const f = await configFixture(t);
  let created = 0,
    settled = 0;
  const faux = fauxProvider({ provider: 'bridge-fixture' });
  faux.setResponses([
    fauxAssistantMessage('first synthetic response'),
    fauxAssistantMessage('second synthetic response'),
  ]);
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const bridge = await new Bridge(f.config, async (saved) => {
    created++;
    const manager = SessionManager.open(saved.file);
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir: path.join(f.dir, 'isolated-agent'),
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: [],
      resourceLoader: loader(),
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        cacheWarming: 'off',
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    });
    const tasks = [];
    session.subscribe((e) => {
      if (e.type === 'agent_settled') settled++;
    });
    return {
      alive: true,
      state: async () => ({ isStreaming: session.isStreaming, isCompacting: session.isCompacting }),
      entries: async () => ({ entries: manager.getEntries(), leafId: manager.getLeafId() }),
      command: async (command) =>
        new Promise((resolve, reject) => {
          const task = session
            .prompt(command.message, {
              streamingBehavior: command.streamingBehavior,
              preflightResult: (disposition) => resolve({ disposition }),
            })
            .catch(reject);
          tasks.push(task);
        }),
      stop: async function () {
        await Promise.all(tasks);
        session.dispose();
        this.alive = false;
      },
      done: async () => Promise.all(tasks),
    };
  }).init();
  try {
    const made = await savedSession(bridge);
    const sent = await bridge.send({
      session_id: made.session_id,

      text: 'first',
      mode: 'idle_only',
    });
    assert.equal(sent.status, 'started');
    await bridge.pool.get(made.session_id).done();
    const data = await bridge.read({ session_id: made.session_id });
    assert.ok(JSON.stringify(data).includes('first synthetic response'));
    await bridge.pool.stop(made.session_id);
    const sent2 = await bridge.send({
      session_id: made.session_id,

      text: 'second',
      mode: 'idle_only',
    });
    assert.equal(sent2.status, 'started');
    await bridge.pool.get(made.session_id).done();
    assert.equal(created, 2);
    assert.equal(faux.state.callCount, 2);
    assert.equal(settled, 2);
    const saved = await loadSavedSession(await bridge.session(made.session_id));
    assert.ok(saved.entries.some((e) => e.message?.role === 'assistant'));
  } finally {
    await bridge.close();
  }
});

test('standard MCP stdio client initializes and exercises the single-operation tools alongside batch', async (t) => {
  const f = await configFixture(t);
  f.config.grants[0].send = false;
  f.config.piArgs.push(
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
  );
  const filename = path.join(f.dir, 'owner-config.json');
  await fs.writeFile(filename, JSON.stringify(f.config), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(base, 'src/server.mjs'), filename],
    cwd: base,
    env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, packageInfo.version);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
      'batch',
      'command',
      'compact',
      'create',
      'delete',
      'health',
      'list',
      'models',
      'read',
      'search',
      'send',
      'set_model',
      'stop',
      'submission',
    ]);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError);
      return result.structuredContent;
    };
    const made = await call('create', {
      project: f.cwd,

      text: 'initial fixture',
    });
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    assert.equal((await call('list', {})).sessions.length, 1);
    assert.equal((await call('read', { session_id: made.session_id })).session_id, made.session_id);
    assert.equal((await call('health', {})).domain, 'permissions');
    const sent = await call('send', {
      session_id: made.session_id,

      text: 'hello',
    });
    assert.equal(sent.status, 'rejected');
    assert.equal((await call('delete', { session_id: made.session_id })).status, 'deleted');
  } finally {
    await client.close();
  }
});

test('MCP -> official Pi RPC -> faux provider: auto-resume, all four modes and content read', async (t) => {
  const f = await configFixture(t);
  f.config.piArgs.push(
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
  );
  const filename = path.join(f.dir, 'owner-config.json');
  await fs.writeFile(filename, JSON.stringify(f.config), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(base, 'src/server.mjs'), filename],
    cwd: base,
    env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-e2e-faux-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent;
    };
    const made = await call('create', { project: f.cwd, text: 'hello' });
    const session_id = made.session_id;
    const first = made.send;
    assert.ok(['started', 'queued', 'handled'].includes(first.status), JSON.stringify(first));
    assert.equal(first.status, 'started');
    const skipped = await call('send', {
      session_id,

      text: 'should skip',
      mode: 'idle_only',
    });
    assert.equal(skipped.status, 'skipped');
    const native = await call('send', {
      session_id,

      text: 'default steering',
      mode: 'default',
    });
    assert.equal(native.status, 'queued');
    const steer = await call('send', {
      session_id,

      text: 'please steer',
      mode: 'steer',
    });
    assert.equal(steer.status, 'queued');
    const queued = await call('send', {
      session_id,

      text: 'please follow up',
      mode: 'follow_up',
    });
    assert.equal(queued.status, 'queued');

    const deadline = Date.now() + 10000;
    let observed;
    do {
      observed = await call('read', { session_id, preset: 'full' });
      if (
        JSON.stringify(observed).includes('Synthetic response 3.') &&
        JSON.stringify(observed).includes('please follow up')
      )
        break;
      await new Promise((r) => setTimeout(r, 100));
    } while (Date.now() < deadline);
    assert.ok(JSON.stringify(observed).includes('Synthetic response 3.'), JSON.stringify(observed));
    assert.ok(JSON.stringify(observed).includes('please follow up'));
    assert.equal(JSON.stringify(observed).includes('should skip'), false);
    assert.ok(JSON.stringify(observed).includes('default steering'));
    const removed = await call('delete', { session_id });
    assert.equal(removed.status, 'deleted');
  } finally {
    await client.close();
  }
});

test('real RPC preparation barrier preserves unknown receipts and fences admission until ACK or process exit', async (t) => {
  const f = await configFixture(t),
    extension = path.join(f.dir, 'admission-barrier.mjs');
  const entered = path.join(f.dir, 'entered.jsonl'),
    release = path.join(f.dir, 'release');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises';
import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(aiEntry)};
export default function(pi){
 globalThis.fetch=async()=>{throw new Error('OFFLINE_FIXTURE');};
 const faux=fauxProvider({provider:'admission-fixture',models:[{id:'slow',name:'Offline admission fixture'}],tokensPerSecond:10,tokenSize:{min:1,max:1}});
 faux.setResponses([fauxAssistantMessage('Long synthetic response holds the first run active for normal steer and queue admission.')]);pi.registerProvider(faux.provider);
 pi.on('before_agent_start',async(event)=>{
  await fs.appendFile(${JSON.stringify(entered)},JSON.stringify({pid:process.pid,prompt:event.prompt})+'\\n');
  if(event.prompt.startsWith('HOLD'))while(!await fs.stat(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,5));
 });
}`,
  );
  f.config.piArgs = [
    '--offline',
    '-e',
    extension,
    '--provider',
    'admission-fixture',
    '--model',
    'slow',
    '--thinking',
    'off',
  ];
  const bridge = await new Bridge(f.config).init();
  const rows = async () => {
    try {
      return (await fs.readFile(entered, 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    } catch (e) {
      if (e.code === 'ENOENT') return [];
      throw e;
    }
  };
  const until = async (predicate) => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      if (await predicate()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('ADMISSION_FIXTURE_DEADLINE');
  };
  try {
    const made = await savedSession(bridge),
      session_id = made.session_id;
    const restoreTimeout = ackTimeout(t, ['prompt']);
    const first = await bridge.send({
      session_id,

      text: 'HOLD first',
    });
    restoreTimeout();
    assert.equal(first.status, 'unknown');
    assert.equal(first.reason, 'ACK_TIMEOUT');
    const runtime = bridge.pool.get(session_id);
    await until(async () => (await rows()).length === 1);
    assert.equal((await runtime.state()).isStreaming, true); // Pi 1.3 counts before_agent_start as an active run.
    assert.ok(Array.isArray((await runtime.entries()).entries));

    for (const mode of ['default', 'idle_only', 'steer', 'follow_up']) {
      const receipt = await bridge.send({
        session_id,

        text: 'BLOCKED ' + mode,
        mode,
      });
      assert.equal(receipt.status, mode === 'idle_only' ? 'skipped' : 'rejected');
      assert.equal(receipt.reason, mode === 'idle_only' ? 'busy' : 'PROMPT_ADMISSION_PENDING');
    }
    assert.equal((await rows()).length, 1);
    await fs.writeFile(release, 'release');
    await until(() => !runtime.promptAdmission);
    for (const mode of ['steer', 'follow_up']) {
      const receipt = await bridge.send({
        session_id,

        text: 'normal ' + mode,
        mode,
      });
      assert.ok(['started', 'queued', 'handled'].includes(receipt.status), JSON.stringify(receipt));
      assert.equal(receipt.status, 'queued');
    }
    assert.equal(
      (await bridge.send({ session_id, text: 'busy check', mode: 'idle_only' })).reason,
      'busy',
    );
    assert.equal(
      (await rows()).some((row) => row.prompt.startsWith('BLOCKED')),
      false,
    );
    await bridge.pool.stop(session_id);
    assert.equal(runtime.exited, true);
    // A separate held admission ends with exact child death, not a late ACK.
    await fs.unlink(release);
    const restoreHeldTimeout = ackTimeout(t, ['prompt']);
    const held = await bridge.send({
      session_id,

      text: 'HOLD until exit',
    });
    restoreHeldTimeout();
    assert.equal(held.status, 'unknown');
    const old = bridge.pool.get(session_id),
      oldGeneration = old.generation;
    assert.ok(old.promptAdmission);
    await bridge.pool.stop(session_id);
    assert.equal(old.exited, true);
    assert.equal(old.promptAdmission, null);

    await fs.writeFile(release, 'release');
    const next = await bridge.send({
      session_id,

      text: 'fresh runtime',
    });
    assert.ok(['started', 'queued', 'handled'].includes(next.status), JSON.stringify(next));
    assert.equal(next.status, 'started');
    assert.notEqual(bridge.pool.get(session_id).generation, oldGeneration);
  } finally {
    await bridge.close();
  }
});

test('official Pi RPC preserves Unicode line separators in native session messages', async (t) => {
  const f = await configFixture(t),
    bridge = await new Bridge(f.config).init();
  try {
    const made = await savedSession(bridge),
      saved = await bridge.session(made.session_id);
    const manager = SessionManager.open(saved.file),
      content = 'Before\u2028between\u2029after 😀 汉字';
    manager.appendMessage({ role: 'user', content, timestamp: Date.now() });
    assert.equal(
      (await bridge.read({ session_id: made.session_id, detail: 'full' })).items[0].message.content,
      content,
    );
    const runtime = await bridge.pool.resolve(await bridge.session(made.session_id));
    assert.equal((await runtime.state()).sessionId, saved.header.id);
    const live = await bridge.read({ session_id: made.session_id, detail: 'full' });
    assert.equal(live.items[0].message.content, content);
  } finally {
    await bridge.close();
  }
});
