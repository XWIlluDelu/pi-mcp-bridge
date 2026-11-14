import { offlineModels } from './fixtures/native-sdk.mjs';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { ownerEnvelope } from '../src/attachment-protocol.mjs';
import { until } from './fixtures/until.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

import { fauxProvider, fauxAssistantMessage } from './fixtures/pi.mjs';
import {
  createAgentSessionRuntime,
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  SettingsManager,
  RpcClient,
} from './fixtures/pi.mjs';

import attachExtension from './fixtures/companion.mjs';
import { claimFile, readClaim } from '../src/attachments.mjs';

import { nativePiCli } from './fixtures/isolated-runtime.mjs';

async function fixture(t, extension) {
  const f = await nativeOwner(t, {
    prefix: 'companion-life',
    configure({ config }) {
      config.piArgs.push(...fauxArgs, '--thinking', 'off');
    },
  });
  const { bridge, config, cwd, dir, session: a } = f;
  const b = await f.create();
  const previous = ['PI_MCP_OWNER_CONFIG', 'PI_MCP_ATTACH_DIR'].map((key) => [
    key,
    process.env[key],
  ]);
  for (const [key] of previous) process.env[key] = f.env[key];
  const finishers = [],
    errors = [];
  let runtime;
  f.cleanup.push(async () => {
    try {
      for (const finish of finishers) finish();
      await runtime?.session.abort();
      await runtime?.dispose();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
  const faux = fauxProvider({
    provider: 'bridge-fixture',
    models: [{ id: 'deterministic' }, { id: 'other' }],
    tokensPerSecond: 10000,
  });
  const modelRuntime = await offlineModels(faux);
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
  return { config, bridge, a, b, runtime, modelRuntime, faux, finishers, errors };
}

test('native replacement ignores old endpoint metadata and retains explicit pauses through reload and switch', async (t) => {
  let f,
    replaceMetadata = false;
  f = await fixture(t, (pi) => {
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

test('ordinary RPC refuses a native switch to another live writer', async (t) => {
  const f = await nativeOwner(t);
  const second = await f.create();
  const extension = new URL('../src/attach-extension.mjs', import.meta.url).pathname;
  const clients = [];
  for (const session of [f.session, second]) {
    const client = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
      env: f.env,
      args: [...f.config.piArgs, '--session', session.file, '-e', extension, ...fauxArgs],
    });
    clients.push(client);
    f.cleanup.push(() => client.stop());
    await client.start();
    await client.getState();
  }
  const [first, other] = clients;
  const alias = path.join(f.cwd, 'alias.jsonl');
  await fs.symlink(second.file, alias);
  for (const target of [second.file, alias]) {
    assert.deepEqual(await first.switchSession(target), { cancelled: true });
    assert.equal((await first.getState()).sessionFile, f.session.file);
    assert.equal((await other.getState()).sessionFile, second.file);
  }
});

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
            ownerEnvelope(claim, {
              op: 'set_model',
              body: { model: { provider: 'bridge-fixture', id: 'other' } },
            }),
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
        assert.deepEqual(f.errors, []);
      },
    );
