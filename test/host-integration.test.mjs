import { nativeOwner } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

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

import { processIdentity, readClaim } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(t) {
  let spawned = 0;
  const f = await nativeOwner(t, {
    factory: async () => {
      spawned++;
      assert.fail('unexpected second writer');
    },
  });
  const controllers = [],
    cleanups = [];
  f.cleanup.push(async () => {
    for (const close of cleanups) await close();
    for (const controller of controllers) await controller.close();
  });
  return Object.assign(f, { controllers, cleanups, spawned: () => spawned });
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
      extension,
    ],
  });
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

test('two official SDK sessions in one host PID release independently without shutting down their neighbor', async (t) => {
  const f = await fixture(t),
    savedA = await f.create('sdk-a'),
    savedB = await f.create('sdk-b');
  const faux = fauxProvider({
    provider: 'host-sdk-fixture',
    models: [{ id: 'a', input: ['text'] }],
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
