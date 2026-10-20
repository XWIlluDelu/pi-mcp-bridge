import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import {
  RpcClient,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { readClaim, processIdentity } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';

async function until(fn) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(10);
  }
  throw new Error('STOP_NATIVE_FIXTURE_TIMEOUT');
}
async function fixture(t, owned = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-stop-native-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const extension = path.join(dir, 'provider.mjs'),
    pidFile = path.join(dir, 'pid.json');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs';
 import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(path.resolve('node_modules/@earendil-works/pi-ai/dist/index.js'))};
 export default pi=>{
   globalThis.fetch=async()=>{throw new Error('offline fixture blocks network');};
   fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(process.pid));
   const faux=fauxProvider({provider:'stop-native-fixture',models:[{id:'slow'}],tokensPerSecond:40,tokenSize:{min:4,max:4}});
   faux.setResponses(Array.from({length:20},(_,i)=>fauxAssistantMessage(i%2===0?'slow response '.repeat(1000):'AFTER_STOP_REPLY')));
   pi.registerProvider(faux.provider);
   pi.on('user_bash',event=>{if(event.command==='HOOK_ONLY')return {result:{output:'HOOK_NATIVE_RESULT',exitCode:0,cancelled:false,truncated:false}};});
 };`,
  );
  const config = {
    principal: 'native-stop',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, stop: true, create: true }],
    ...isolatedRuntime(dir),
  };
  config.piArgs.push(
    '--provider',
    'stop-native-fixture',
    '--model',
    'slow',
    '--thinking',
    'off',
    '-e',
    extension,
  );
  await fs.mkdir(config.piRuntime.agentDir, { recursive: true });
  await fs.writeFile(
    path.join(config.piRuntime.agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  const bridge = await new Bridge(
    config,
    owned ? undefined : async () => assert.fail('external owner must not spawn Pi'),
  ).init();
  const made = await savedSession(bridge, { folder_id: 'project', request_id: 'seed' }),
    saved = await bridge.session(made.session_id);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, cwd, config, bridge, saved, extension, pidFile, cleanups };
}
async function exerciseBash(f, native) {
  const id = f.saved.id,
    rule = f.config.grants[0];
  rule.send = false;
  rule.command = false;
  rule.read = false;
  await assert.rejects(
    f.bridge.bash({ session_id: id, request_id: 'default-deny', command: 'echo MUST_NOT_RUN' }),
    /NOT_FOUND_OR_DENIED/,
  );
  rule.command = true;
  const text = 'native direct 😀 "\\n'.repeat(1200),
    command = "printf '%s' '" + text.replaceAll("'", "'\\''") + "'";
  const first = await f.bridge.bash({
    session_id: id,
    request_id: 'direct',
    command,
    max_chars: 512,
  });
  assert.equal(first.status, 'accepted');
  assert.equal(first.truncated, false);
  assert.equal(first.exitCode, 0);
  let output = first.output,
    cursor = first.next_cursor;
  assert.ok(cursor);
  while (cursor) {
    const page = await f.bridge.bash({
      session_id: id,
      request_id: 'direct',
      cursor,
      max_chars: 32768,
    });
    output += page.output;
    cursor = page.next_cursor;
  }
  assert.equal(output, text);
  assert.equal(
    (await f.bridge.bash({ session_id: id, request_id: 'direct' })).total_text_units,
    text.length,
  );
  await assert.rejects(
    f.bridge.bash({ session_id: id, request_id: 'direct', command: 'different' }),
    /REQUEST_ID_CONFLICT/,
  );
  rule.command = false;
  await assert.rejects(
    f.bridge.bash({ session_id: id, request_id: 'direct' }),
    /NOT_FOUND_OR_DENIED/,
  );
  rule.command = true;
  const entries = (await native.getEntries()).entries;
  assert.equal(
    entries.filter(
      (entry) => entry.message?.role === 'bashExecution' && entry.message.command === command,
    ).length,
    1,
  );
  assert.ok(!entries.some((entry) => entry.message?.role === 'user'));
  const hook = await f.bridge.bash({
    session_id: id,
    request_id: 'native-hook',
    command: 'HOOK_ONLY',
  });
  assert.equal(hook.output, 'HOOK_NATIVE_RESULT');
  const failing = await f.bridge.bash({
    session_id: id,
    request_id: 'nonzero',
    command: 'printf nonzero; exit 7',
  });
  assert.equal(failing.exitCode, 7);
  assert.equal(failing.output, 'nonzero');
  Object.assign(rule, { list: true, read: true, send: true, stop: true });
  const started = path.join(f.dir, 'direct-bash-started');
  const bash = f.bridge.bash({
    session_id: id,
    request_id: 'direct-stop',
    command: "printf started > '" + started + "'; sleep 30",
    timeout_ms: 10000,
  });
  await until(async () => {
    try {
      return (await fs.readFile(started, 'utf8')) === 'started';
    } catch {
      return false;
    }
  });
  assert.equal(
    (await f.bridge.stop({ session_id: id, request_id: 'stop-direct' })).status,
    'accepted',
  );
  const cancelled = await bash;
  assert.equal(cancelled.status, 'accepted');
  assert.equal(cancelled.cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}
async function exercise(f, native) {
  const first = await f.bridge.send({
    session_id: f.saved.id,
    request_id: 'run',
    text: 'START_SLOW',
  });
  assert.ok(['accepted', 'unknown'].includes(first.status));
  await until(async () => (await native.getState()).isStreaming);
  const steering = 'STEERING 😀 " \\ ' + 'long queued text '.repeat(4000),
    followUp = 'FOLLOW_UP_PROMPT';
  assert.equal(
    (
      await f.bridge.send({
        session_id: f.saved.id,
        request_id: 'steer',
        text: steering,
        mode: 'steer',
      })
    ).status,
    'accepted',
  );
  assert.equal(
    (
      await f.bridge.send({
        session_id: f.saved.id,
        request_id: 'follow',
        text: followUp,
        mode: 'follow_up',
      })
    ).status,
    'accepted',
  );
  assert.equal((await native.getState()).pendingMessageCount, 2);
  let cursor,
    out = '',
    receipt;
  do {
    receipt = await f.bridge.stop({
      session_id: f.saved.id,
      request_id: 'stop-agent',
      max_chars: 512,
      cursor,
    });
    assert.equal(receipt.status, 'accepted');
    out += receipt.withdrawn_text;
    cursor = receipt.next_cursor;
  } while (cursor);
  assert.equal(out, steering + '\n\n' + followUp);
  assert.equal((await native.getState()).pendingMessageCount, 0);
  assert.equal((await native.getState()).isStreaming, false);
  const claim = await readClaim(f.bridge.pool.attachmentDir, f.saved),
    generation = receipt.generation;
  assert.equal(generation, f.bridge.pool.get(f.saved.id).generation ?? claim.generation);
  const entries = (await native.getEntries()).entries;
  assert.ok(
    !entries.some(
      (entry) =>
        entry.message?.role === 'user' &&
        JSON.stringify(entry.message.content).includes('FOLLOW_UP_PROMPT'),
    ),
  );
  // Independent native bash is not covered by agent abort alone.
  const bash = native.bash('sleep 30');
  await delay(100);
  const stopped = await f.bridge.stop({ session_id: f.saved.id, request_id: 'stop-bash' });
  assert.equal(stopped.status, 'accepted');
  assert.equal((await bash).cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
  const after = await f.bridge.send({
    session_id: f.saved.id,
    request_id: 'after',
    text: 'CONTINUE_NORMALLY',
  });
  assert.ok(['accepted', 'unknown'].includes(after.status));
  await until(async () => !(await native.getState()).isStreaming);
  assert.match(JSON.stringify((await native.getEntries()).entries), /AFTER_STOP_REPLY/);
  assert.equal(
    (await f.bridge.stop({ session_id: f.saved.id, request_id: 'stop-agent' })).generation,
    generation,
  );
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}

test(
  'Bridge-owned actual offline Pi cancels agent and independent bash, returns all queued text, continues same process',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true);
    await exerciseBash(f, {
      getEntries: () => f.bridge.pool.get(f.saved.id).entries(),
      getState: () => f.bridge.pool.get(f.saved.id).command({ type: 'get_state' }),
    });
    // A later prompt starts normally in the same owned runtime.
    const seed = await f.bridge.send({
      session_id: f.saved.id,
      request_id: 'run',
      text: 'START_SLOW',
    });
    assert.equal(seed.status, 'accepted');
    const runtime = f.bridge.pool.get(f.saved.id),
      pid = runtime.child.pid;
    const native = {
      getState: () => runtime.command({ type: 'get_state' }),
      getEntries: () => runtime.entries(),
      bash: (command) => runtime.command({ type: 'bash', command }, 10000),
    };
    await exercise(f, native);
    assert.equal(runtime.child.pid, pid);
    assert.equal(runtime.alive, true);
  },
);

test(
  'public RPC host binding uses existing child and returns all withdrawal through private IPC',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      controller = await reserveHostSession({
        attachmentDir: f.bridge.pool.attachmentDir,
        session: f.saved,
      });
    const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    Object.assign(env, {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: f.config.piRuntime.agentDir,
      PI_OFFLINE: '1',
    });
    const client = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
      env,
      args: ['--session', f.saved.file, ...f.config.piArgs],
    });
    f.cleanups.push(async () => {
      await client.stop();
      await controller.close();
    });
    await client.start();
    await client.getState();
    await controller.ready(createRpcHostBinding(client), {
      owner: await processIdentity(JSON.parse(await fs.readFile(f.pidFile, 'utf8'))),
    });
    await exerciseBash(f, client);
    await exercise(f, client);
  },
);

test(
  'public SDK host cancels agent, retry, compaction, branch summary and bash without disposal',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      controller = await reserveHostSession({
        attachmentDir: f.bridge.pool.attachmentDir,
        session: f.saved,
      });
    const faux = fauxProvider({
      provider: 'stop-sdk-fixture',
      tokensPerSecond: 40,
      tokenSize: { min: 4, max: 4 },
    });
    faux.setResponses([
      fauxAssistantMessage('slow reply '.repeat(1000)),
      fauxAssistantMessage('SDK_CONTINUES'),
      fauxAssistantMessage('slow summary '.repeat(1000)),
    ]);
    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = SettingsManager.inMemory({
      cacheWarming: 'off',
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 128 },
      retry: { enabled: false, maxRetries: 1, baseDelayMs: 10000, maxDelayMs: 10000 },
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: f.cwd,
      agentDir: f.config.piRuntime.agentDir,
      settingsManager,
      extensionFactories: [
        (pi) =>
          pi.on('user_bash', (event) =>
            event.command === 'HOOK_ONLY'
              ? {
                  result: {
                    output: 'HOOK_NATIVE_RESULT',
                    exitCode: 0,
                    cancelled: false,
                    truncated: false,
                  },
                }
              : undefined,
          ),
      ],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      systemPrompt: 'Offline stop fixture.',
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: f.cwd,
      agentDir: f.config.piRuntime.agentDir,
      modelRuntime,
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: [],
      resourceLoader,
      settingsManager,
      sessionManager: SessionManager.open(f.saved.file),
    });
    f.cleanups.push(async () => {
      await session.abort();
      session.dispose();
      await controller.close();
    });
    await controller.ready(createSdkHostBinding(session));
    await exerciseBash(f, {
      getEntries: async () => ({ entries: session.sessionManager.getEntries() }),
      getState: async () => ({ sessionId: session.sessionId }),
    });
    assert.equal(faux.state.callCount, 0);
    const run = session.prompt('SDK_SLOW');
    await until(() => session.isStreaming && faux.state.callCount === 1);
    await session.steer('SDK_STEERING');
    await session.followUp('SDK_FOLLOW_UP');
    const stopped = await f.bridge.stop({ session_id: f.saved.id, request_id: 'sdk-stop' });
    assert.equal(stopped.withdrawn_text, 'SDK_STEERING\n\nSDK_FOLLOW_UP');
    await run;
    assert.equal(session.pendingMessageCount, 0);
    const bash = session.executeBash('sleep 30');
    await until(() => session.isBashRunning);
    assert.equal(
      (await f.bridge.stop({ session_id: f.saved.id, request_id: 'sdk-bash' })).status,
      'accepted',
    );
    assert.equal((await bash).cancelled, true);
    await session.prompt('SDK_NEXT');
    assert.match(JSON.stringify(session.sessionManager.getEntries()), /SDK_CONTINUES/);
    const compact = session.compact().catch((error) => error);
    await until(() => session.isCompacting);
    assert.equal(
      (await f.bridge.stop({ session_id: f.saved.id, request_id: 'sdk-compact' })).status,
      'accepted',
    );
    await compact;
    assert.equal(session.isCompacting, false);
    assert.equal(session.sessionId, f.saved.header.id);
    settingsManager.setRetryEnabled(true);
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit' }),
    ]);
    const retry = session.prompt('SDK_RETRY');
    await until(() => session.retryAttempt > 0);
    assert.equal(
      (await f.bridge.stop({ session_id: f.saved.id, request_id: 'sdk-retry' })).status,
      'accepted',
    );
    await retry;
    assert.equal(session.retryAttempt, 0);
    settingsManager.setRetryEnabled(false);
    // Summarization cancellation uses the same public session.abort umbrella.
    faux.setResponses([fauxAssistantMessage('slow branch summary '.repeat(1000))]);
    const target = session.sessionManager
      .getEntries()
      .find((entry) => entry.message?.role === 'user').id;
    const beforeCalls = faux.state.callCount,
      branch = session.navigateTree(target, { summarize: true }).catch((error) => error);
    await until(() => faux.state.callCount > beforeCalls);
    assert.equal(
      (await f.bridge.stop({ session_id: f.saved.id, request_id: 'sdk-branch' })).status,
      'accepted',
    );
    await branch;
    assert.equal(session.sessionId, f.saved.header.id);
  },
);
