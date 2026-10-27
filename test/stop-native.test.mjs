import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { aiEntry } from './fixtures/pi.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession, savedEntries } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fauxProvider, fauxAssistantMessage, InMemoryCredentialStore } from './fixtures/pi.mjs';
import {
  RpcClient,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { executeBatch } from '../src/batch.mjs';
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
 import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(aiEntry)};
 export default pi=>{
   globalThis.fetch=async()=>{throw new Error('offline fixture blocks network');};
   fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(process.pid));
   const faux=fauxProvider({provider:'stop-native-fixture',models:[{id:'slow'}],tokensPerSecond:40,tokenSize:{min:4,max:4}});
   faux.setResponses(Array.from({length:20},()=>async(context)=>fauxAssistantMessage(JSON.stringify(context.messages.findLast(m=>m.role==='user')?.content).includes('CONTINUE_NORMALLY')?'AFTER_STOP_REPLY':'slow response '.repeat(1000))));
   pi.registerProvider(faux.provider);
   pi.on('user_bash',event=>{if(event.command==='HOOK_ONLY')return {result:{output:'HOOK_NATIVE_RESULT',exitCode:0,cancelled:false,truncated:false}};});
 };`,
  );
  const config = {
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
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
  const made = await savedSession(bridge),
    saved = await bridge.session(made.session_id);
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, cwd, config, bridge, saved, extension, pidFile, cleanups };
}
for (const op of ['send', 'command'])
  test(
    'batch lane ' + op + ' stays withdrawn after external Stop and a later batch Stop',
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t, true),
        id = f.saved.id;
      f.config.grants[0].command = true;
      await f.bridge.pool.resolve(f.saved);
      const entered = Promise.withResolvers(),
        finish = Promise.withResolvers();
      f.cleanups.push(() => finish.resolve());
      const read = f.bridge.read.bind(f.bridge);
      let held = false;
      t.mock.method(f.bridge, 'read', async (...args) => {
        const value = await read(...args);
        if (!held) {
          held = true;
          entered.resolve();
          await finish.promise;
        }
        return value;
      });
      const input = {
        op,
        args: {
          session_id: id,
          ...(op === 'send'
            ? { text: 'MUST_NOT_DISPATCH' }
            : { command: 'printf MUST_NOT_DISPATCH' }),
        },
      };
      const batch = executeBatch(f.bridge, {
        operations: [
          { op: 'read', args: { session_id: id } },
          { op: 'stop', args: { session_id: id } },
          input,
        ],
      });
      await entered.promise;
      assert.equal(f.bridge.inputs.size, 1);
      const stopped = await f.bridge.stop({ session_id: id });
      assert.equal(stopped.status, 'accepted', JSON.stringify(stopped));
      assert.equal(stopped.acknowledgement, 'native_ack');
      finish.resolve();
      const result = await batch;
      assert.equal(result.results[2].result.reason, 'STOP_IN_PROGRESS', JSON.stringify(result));
      assert.equal(f.bridge.inputs.size, 0);
      assert.ok(!(await fs.readFile(f.saved.file, 'utf8')).includes('MUST_NOT_DISPATCH'));
      const fresh = {
        op,
        args: {
          session_id: id,
          ...(op === 'send'
            ? { text: 'CONTINUE_NORMALLY' }
            : { command: 'printf CONTINUE_NORMALLY' }),
        },
      };
      const restarted = await executeBatch(f.bridge, {
        operations: [{ op: 'stop', args: { session_id: id } }, fresh],
      });
      assert.equal(
        restarted.results[1].result.status,
        op === 'send' ? 'started' : 'completed',
        JSON.stringify(restarted),
      );
      assert.equal(f.bridge.inputs.size, 0);
      await until(() => !f.bridge.pool.get(id) && !f.bridge.autoReleases.size);
      assert.equal(
        (await f.bridge[op](fresh.args)).status,
        op === 'send' ? 'started' : 'completed',
      );
    },
  );

test(
  'batch inputs are withdrawn while their shared permission snapshot is pending',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, true),
      id = f.saved.id;
    await f.bridge.pool.resolve(f.saved);
    const policy = Promise.withResolvers();
    const context = await f.bridge.captureRequestContext();
    f.cleanups.push(() => policy.resolve(context));
    const batch = executeBatch(
      f.bridge,
      {
        operations: [
          { op: 'read', args: { session_id: id } },
          { op: 'send', args: { session_id: id, text: 'POLICY_WAIT_INPUT' } },
        ],
      },
      { requestContext: policy.promise },
    );
    assert.equal(f.bridge.inputs.size, 1);
    assert.equal((await f.bridge.stop({ session_id: id })).status, 'accepted');
    policy.resolve(context);
    const result = await batch;
    assert.equal(result.results[1].result.reason, 'STOP_IN_PROGRESS');
    assert.equal(f.bridge.inputs.size, 0);
  },
);

async function exerciseBash(f, native) {
  const id = f.saved.id,
    rule = f.config.grants[0];
  rule.send = false;
  rule.command = false;
  rule.read = false;
  await assert.rejects(
    f.bridge.command({ session_id: id, command: 'echo MUST_NOT_RUN' }),
    /NOT_FOUND_OR_DENIED/,
  );
  rule.command = true;
  const text = 'native direct 😀 "\\n'.repeat(1200),
    command = "printf '%s' '" + text.replaceAll("'", "'\\''") + "'";
  const first = await f.bridge.command({
    session_id: id,

    command,
    max_chars: 512,
  });
  assert.equal(first.status, 'completed');
  assert.equal(first.native_truncated, false);
  assert.equal(first.exitCode, 0);
  assert.equal(first.response_complete, false);
  assert.ok(text.startsWith(first.output));
  assert.ok(JSON.stringify({ output: first.output }).length <= 512);
  assert.equal(first.next_cursor, undefined);
  await assert.rejects(f.bridge.command({ session_id: id, cursor: '' }), /INVALID_ARGUMENTS/);

  rule.command = false;
  await assert.rejects(f.bridge.command({ session_id: id, command }), /NOT_FOUND_OR_DENIED/);
  rule.command = true;
  const entries = (await native.getEntries()).entries;
  assert.equal(
    entries.filter(
      (entry) => entry.message?.role === 'bashExecution' && entry.message.command === command,
    ).length,
    1,
  );
  assert.ok(!entries.some((entry) => entry.message?.role === 'user'));
  const hook = await f.bridge.command({
    session_id: id,

    command: 'HOOK_ONLY',
  });
  assert.equal(hook.output, 'HOOK_NATIVE_RESULT');
  const failing = await f.bridge.command({
    session_id: id,

    command: 'printf nonzero; exit 7',
  });
  assert.equal(failing.status, 'completed');
  assert.equal(failing.exitCode, 7);
  assert.equal(failing.output, 'nonzero');
  Object.assign(rule, { list: true, read: true, send: true, stop: true });
  const started = path.join(f.dir, 'direct-bash-started');
  const bash = f.bridge.command({
    session_id: id,

    command: "printf started > '" + started + "'; sleep 30",
  });
  await until(async () => {
    try {
      return (await fs.readFile(started, 'utf8')) === 'started';
    } catch {
      return false;
    }
  });
  try {
    assert.equal((await f.bridge.list({ session_id: id })).sessions[0].status.state, 'busy');
  } finally {
    assert.equal((await f.bridge.stop({ session_id: id })).status, 'accepted');
  }
  const cancelled = await bash;
  assert.equal(cancelled.status, 'completed');
  assert.equal(cancelled.cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}
async function exercise(f, native) {
  const first = await f.bridge.send({
    session_id: f.saved.id,

    text: 'START_SLOW',
  });
  assert.ok(['started', 'unknown'].includes(first.status));
  await until(async () => (await native.getState()).isStreaming);
  const steering = 'STEERING 😀 " \\ ' + 'long queued text '.repeat(4000),
    followUp = 'FOLLOW_UP_PROMPT';
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.saved.id,

          text: steering,
          mode: 'steer',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  assert.ok(
    ['started', 'queued', 'handled'].includes(
      (
        await f.bridge.send({
          session_id: f.saved.id,

          text: followUp,
          mode: 'follow_up',
        })
      ).status,
    ),
    'Expected native prompt admission',
  );
  assert.equal((await native.getState()).pendingMessageCount, 2);
  const receipt = await f.bridge.stop({ session_id: f.saved.id, max_chars: 32768 });
  assert.equal(receipt.status, 'accepted');
  const out = receipt.withdrawn_text;
  assert.ok((steering + '\n\n' + followUp).startsWith(out));
  assert.equal(receipt.withdrawn_complete, false);
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
  const stopped = await f.bridge.stop({ session_id: f.saved.id });
  assert.equal(stopped.status, 'accepted');
  assert.equal((await bash).cancelled, true);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
  const after = await f.bridge.send({
    session_id: f.saved.id,

    text: 'CONTINUE_NORMALLY',
  });
  assert.ok(['started', 'unknown'].includes(after.status));
  await until(async () => !(await native.getState()).isStreaming);
  assert.match(JSON.stringify((await native.getEntries()).entries), /AFTER_STOP_REPLY/);
  assert.equal((await f.bridge.stop({ session_id: f.saved.id })).generation, generation);
  assert.equal((await native.getState()).sessionId, f.saved.header.id);
}

test(
  'Bridge-owned offline Pi cancels agent and bash, withdraws queued text, then releases and resumes history',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t, true),
      id = f.saved.id;
    await exerciseBash(f, {
      getEntries: async () => ({ entries: await savedEntries(f.bridge, id) }),
      getState: async () => {
        await f.bridge.pool.instances.get(id)?.autoReleaseTask;
        return (await f.bridge.pool.resolve(await f.bridge.session(id))).state();
      },
    });
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: id, text: 'START_SLOW' })).status,
      ),
      'Expected native prompt admission',
    );
    const runtime = f.bridge.pool.get(id),
      generation = runtime.generation;
    await until(async () => (await runtime.state()).isStreaming);
    const steering = 'STEERING 😀 " \\ ' + 'long queued text '.repeat(4000),
      followUp = 'FOLLOW_UP_PROMPT';
    for (const [mode, text] of [
      ['steer', steering],
      ['follow_up', followUp],
    ])
      assert.equal((await f.bridge.send({ session_id: id, mode, text })).status, 'queued');
    const marker = path.join(f.dir, 'concurrent-bash');
    const bash = f.bridge.command({
      session_id: id,

      command: "printf started > '" + marker + "'; sleep 30",
    });
    await until(() =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    const stopped = await f.bridge.stop({ session_id: id, max_chars: 32768 });
    assert.equal(stopped.status, 'accepted');
    assert.ok((steering + '\n\n' + followUp).startsWith(stopped.withdrawn_text));
    assert.equal(stopped.withdrawn_complete, false);
    assert.equal((await bash).cancelled, true);
    await until(() => runtime.exited && !f.bridge.autoReleases.size);
    assert.equal(runtime.child.exitCode, 0);
    assert.equal(runtime.child.signalCode, null);
    assert.equal(
      (await savedEntries(f.bridge, id)).filter((e) => e.message?.role === 'user').length,
      1,
    );
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: id, text: 'CONTINUE_NORMALLY' })).status,
      ),
      'Expected native prompt admission',
    );
    const next = f.bridge.pool.get(id);
    assert.notEqual(next.generation, generation);
    await until(() => next.exited && !f.bridge.autoReleases.size);
    assert.match(JSON.stringify(await savedEntries(f.bridge, id)), /AFTER_STOP_REPLY/);
    assert.equal(next.child.exitCode, 0);
    assert.equal(next.child.signalCode, null);
  },
);

test(
  'public RPC host binding uses existing child and returns all withdrawal through private IPC',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      controller = await reserveHostSession({
        buildSessionProjection: hostProjection,
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
        buildSessionProjection: hostProjection,
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
    const stopped = await f.bridge.stop({ session_id: f.saved.id });
    assert.equal(stopped.withdrawn_text, 'SDK_STEERING\n\nSDK_FOLLOW_UP');
    await run;
    assert.equal(session.pendingMessageCount, 0);
    const bash = session.executeBash('sleep 30');
    await until(() => session.isBashRunning);
    try {
      assert.equal(
        (await f.bridge.list({ session_id: f.saved.id })).sessions[0].status.state,
        'busy',
      );
    } finally {
      assert.equal((await f.bridge.stop({ session_id: f.saved.id })).status, 'accepted');
    }
    assert.equal((await bash).cancelled, true);
    await session.prompt('SDK_NEXT');
    assert.match(JSON.stringify(session.sessionManager.getEntries()), /SDK_CONTINUES/);
    const compact = session.compact().catch((error) => error);
    await until(() => session.isCompacting);
    assert.equal((await f.bridge.stop({ session_id: f.saved.id })).status, 'accepted');
    await compact;
    assert.equal(session.isCompacting, false);
    assert.equal(session.sessionId, f.saved.header.id);
    settingsManager.setRetryEnabled(true);
    faux.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: '429 rate limit' }),
    ]);
    const retry = session.prompt('SDK_RETRY');
    await until(() => session.retryAttempt > 0);
    assert.equal((await f.bridge.stop({ session_id: f.saved.id })).status, 'accepted');
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
    assert.equal((await f.bridge.stop({ session_id: f.saved.id })).status, 'accepted');
    await branch;
    assert.equal(session.sessionId, f.saved.header.id);
  },
);
