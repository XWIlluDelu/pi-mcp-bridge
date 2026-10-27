import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadSavedSession } from '../src/data.mjs';
import {
  RpcClient,
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from './fixtures/pi.mjs';
import { fauxProvider, InMemoryCredentialStore } from './fixtures/pi.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import { AttachedRuntime, processIdentity, readClaim, ownerAlive } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { pngImage, imageEvidence } from './fixtures/image-input.mjs';
import { imageReply, imageInputExtension } from './fixtures/image-provider.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await pause(10);
  }
  throw Error('IMAGE_HOST_TIMEOUT');
}

function tuiClient({ cwd, env, args, saved, config }) {
  let child, record;
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const entries = async () => (await loadSavedSession(saved)).entries;
  return {
    async start() {
      child = spawn(
        'script',
        ['-qefc', [process.execPath, nativePiCli, ...args].map(quote).join(' '), '/dev/null'],
        {
          cwd,
          env: { ...env, PATH: process.env.PATH, TERM: 'xterm-256color', LANG: 'C.UTF-8' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      child.stdout.resume();
      child.stderr.resume();
      record = await until(async () => {
        const owner = await readClaim(config.attachmentDir, saved);
        return owner?.phase === 'ready' ? owner : null;
      });
    },
    async stop() {
      if (!child) return;
      // Test-owned process only; never an MCP/production stop implementation.
      if (record && (await ownerAlive(record.owner))) process.kill(record.owner.pid, 'SIGTERM');
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await until(() => child.exitCode !== null || child.signalCode !== null);
      if (record) await until(async () => !(await ownerAlive(record.owner)));
    },
    async getEntries() {
      return { entries: await entries() };
    },
    async getLastAssistantText() {
      return (await entries())
        .findLast((e) => e.message?.role === 'assistant')
        ?.message.content.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('');
    },
  };
}

for (const route of ['rpc-host', 'companion', 'tui-companion', 'sdk-host'])
  test(
    'native images reach provider through ' + route + ' without a second writer',
    { timeout: 20000 },
    async (t) => {
      const dir = await fs.mkdtemp('/tmp/pi-images-'),
        cwd = path.join(dir, 'project'),
        agentDir = path.join(dir, 'agent');
      await fs.mkdir(cwd);
      await fs.mkdir(agentDir);
      const settingsValue = {
        images: { autoResize: false },
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      };
      await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settingsValue));
      const config = {
        defaults: denyAllPermissions(),
        stateDir: path.join(dir, 'state'),
        sessionRoots: [path.join(dir, 'sessions')],
        folders: [{ path: cwd }],
        grants: [{ folder: cwd, list: true, read: true, send: true, command: true, stop: true }],
        attachmentDir: path.join(dir, 'ipc'),
      };
      let spawned = 0;
      const bridge = await new Bridge(config, async () => {
        spawned++;
        throw Error('UNEXPECTED_WRITER');
      }).init();
      const made = await savedSession(bridge),
        saved = await bridge.session(made.session_id);
      let native, controller, sdk, remote;
      t.after(async () => {
        await remote?.close();
        await controller?.close();
        if (sdk) {
          await sdk.abort();
          sdk.dispose();
        }
        await native?.stop();
        await bridge.close();
        await fs.rm(dir, { recursive: true, force: true });
      });
      if (route === 'sdk-host') {
        controller = await reserveHostSession({
          buildSessionProjection: hostProjection,
          attachmentDir: config.attachmentDir,
          session: saved,
        });
        const faux = fauxProvider({
          provider: 'image-sdk',
          models: [
            { id: 'vision', input: ['text', 'image'] },
            { id: 'text-only', input: ['text'] },
            { id: 'reasoner', input: ['text', 'image'], reasoning: true },
          ],
          tokensPerSecond: 10000,
        });
        faux.setResponses(Array.from({ length: 10 }, () => imageReply));
        const modelRuntime = await ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsPath: null,
          refreshOnCreate: false,
          allowModelNetwork: false,
        });
        modelRuntime.registerNativeProvider(faux.provider);
        const settingsManager = SettingsManager.inMemory(settingsValue),
          resourceLoader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager,
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            systemPrompt: 'Image test.',
            extensionFactories: [imageInputExtension],
          });
        await resourceLoader.reload();
        ({ session: sdk } = await createAgentSession({
          cwd,
          agentDir,
          modelRuntime,
          model: faux.getModel(),
          thinkingLevel: 'off',
          tools: [],
          resourceLoader,
          sessionManager: SessionManager.open(saved.file),
          settingsManager,
        }));
        await sdk.bindExtensions({ mode: 'rpc' });
        await controller.ready(createSdkHostBinding(sdk));
      } else {
        const pidFile = path.join(dir, 'pid'),
          extension = path.join(dir, 'identity.mjs');
        await fs.writeFile(
          extension,
          'import fs from "node:fs";export default function(){fs.writeFileSync(' +
            JSON.stringify(pidFile) +
            ',String(process.pid));}',
        );
        const nativeOptions = {
          cliPath: nativePiCli,
          cwd,
          env: {
            HOME: dir,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: '1',
            PI_MCP_ATTACH_DIR: config.attachmentDir,
          },
          provider: 'image-fixture',
          model: 'vision',
          args: [
            '--no-extensions',
            '--no-skills',
            '--no-prompt-templates',
            '--no-themes',
            '--no-tools',
            '-e',
            path.resolve('test/fixtures/image-provider.mjs'),
            '-e',
            extension,
            ...(route.endsWith('companion')
              ? ['--session', saved.file, '-e', path.resolve('src/attach-extension.mjs')]
              : ['--no-session']),
          ],
        };
        native =
          route === 'tui-companion'
            ? tuiClient({
                ...nativeOptions,
                saved,
                config,
                args: [
                  ...nativeOptions.args,
                  '--provider',
                  'image-fixture',
                  '--model',
                  'vision',
                  '--thinking',
                  'off',
                ],
              })
            : new RpcClient(nativeOptions);
        await native.start();
        if (route !== 'tui-companion') await native.getState();
        if (route === 'rpc-host') {
          controller = await reserveHostSession({
            buildSessionProjection: hostProjection,
            attachmentDir: config.attachmentDir,
            session: saved,
            owner: await processIdentity(Number(await fs.readFile(pidFile, 'utf8'))),
          });
          await native.switchSession(saved.file);
          await controller.ready(createRpcHostBinding(native));
        }
      }
      const record = await readClaim(config.attachmentDir, saved);
      assert.equal(record.imagesSupported, true);
      // Companion route also verifies a standard MCP stdio client against the same owner.
      let call = (name, args) => bridge[name](args);
      if (route.endsWith('companion')) {
        const remoteConfig = { ...config, stateDir: path.join(dir, 'remote-state') },
          file = path.join(dir, 'remote-owner.json');
        await fs.writeFile(file, JSON.stringify(remoteConfig), { mode: 0o600 });
        remote = new Client({ name: 'image-stdio', version: '1' });
        await remote.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [path.resolve('src/server.mjs'), file],
            env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: '1' },
            stderr: 'pipe',
          }),
        );
        call = async (name, args) => {
          const r = await remote.callTool({ name, arguments: args });
          assert.ok(!r.isError, JSON.stringify(r));
          return r.structuredContent;
        };
      }
      // Incompressible real PNG exceeds the old 1 MiB IPC request bound.
      const image = pngImage(520, 520);
      assert.ok(Buffer.byteLength(image.data) > 1024 * 1024);
      const sent = await call('send', {
        session_id: saved.id,

        images: [image],
      });
      assert.equal(sent.status, route === 'rpc-host' ? 'started' : 'dispatched');
      if (route !== 'rpc-host') assert.equal(sent.admission, 'unobservable');
      const text = await until(async () => {
        const value = sdk ? sdk.getLastAssistantText() : await native.getLastAssistantText();
        return value?.startsWith('IMAGE_CONTEXT:') ? value : null;
      });
      assert.deepEqual(JSON.parse(text.slice('IMAGE_CONTEXT:'.length)), [imageEvidence(image)]);
      const entries = sdk ? sdk.sessionManager.getEntries() : (await native.getEntries()).entries;
      assert.deepEqual(
        entries
          .find((e) => e.message?.role === 'user')
          .message.content.filter((c) => c.type === 'image'),
        [image],
      );

      assert.equal(
        (sdk ? sdk.sessionManager.getEntries() : (await native.getEntries()).entries).filter(
          (e) => e.message?.role === 'user',
        ).length,
        1,
      );
      const status = async () => (await call('list', { session_id: saved.id })).sessions[0].status;
      const selected = await status();
      assert.deepEqual(selected.model, {
        provider: route === 'sdk-host' ? 'image-sdk' : 'image-fixture',
        id: 'vision',
      });
      assert.equal(selected.thinking_level, 'off');
      const rejected = await call('send', {
        session_id: saved.id,

        text: 'MUST_NOT_SEND',
        model: { provider: selected.model.provider, id: 'text-only' },
      });
      assert.equal(rejected.status, 'rejected');
      assert.equal(rejected.reason, 'MODEL_SELECTION_UNSUPPORTED');
      assert.deepEqual((await status()).model, selected.model);
      for (const settings of [
        { thinking_level: 'off' },
        { model: { provider: selected.model.provider, id: 'reasoner' }, thinking_level: 'high' },
      ]) {
        const refused = await call('send', {
          session_id: saved.id,

          text: 'MUST_NOT_SEND',
          ...settings,
        });
        assert.equal(refused.status, 'rejected');
        assert.equal(refused.reason, 'MODEL_SELECTION_UNSUPPORTED');
      }
      assert.deepEqual((await status()).model, selected.model);
      assert.equal(
        (sdk ? sdk.sessionManager.getEntries() : (await native.getEntries()).entries).filter(
          (e) => e.message?.role === 'user',
        ).length,
        1,
      );
      const publicRead = await call('read', { session_id: saved.id, max_bytes: 65536 });
      assert.ok(JSON.stringify(publicRead.items).includes('IMAGE_CONTEXT:'));
      const denied = await call('compact', { session_id: saved.id });
      assert.equal(denied.status, 'rejected');
      // The one-turn image fixture is too small for native compaction. Only
      // the remote RPC binding lacks the gate needed to attempt idle compact.
      assert.equal(
        denied.reason,
        route === 'rpc-host' ? 'COMPACT_IDLE_UNCONFIRMED' : 'PI_REJECTED',
      );
      if (route.endsWith('companion')) {
        for (const op of ['command', 'stop']) {
          const denied = await call(op, {
            session_id: saved.id,

            ...(op === 'command' ? { command: 'printf MUST_NOT_RUN' } : {}),
          });
          assert.equal(denied.status, 'rejected');
          assert.equal(denied.reason, op === 'command' ? 'BASH_UNSUPPORTED' : 'STOP_UNSUPPORTED');
        }
      }
      assert.deepEqual((await readClaim(config.attachmentDir, saved)).owner, record.owner);
      assert.equal((await readClaim(config.attachmentDir, saved)).generation, record.generation);
      assert.equal(spawned, 0);
      const small = pngImage(),
        evidence = imageEvidence(small);
      await call('set_model', {
        session_id: saved.id,
        model: { provider: selected.model.provider, id: 'text-only' },
      });
      const handled = await call('send', {
        session_id: saved.id,
        text: 'HANDLE_IMAGE_TEST ' + evidence.sha256,
        images: [small],
      });
      assert.equal(handled.status, route === 'rpc-host' ? 'handled' : 'dispatched');
      if (route !== 'rpc-host') assert.equal(handled.admission, 'unobservable');
      const inputRecord = await until(async () => {
        const entries = sdk ? sdk.sessionManager.getEntries() : (await native.getEntries()).entries;
        return entries.findLast(
          (e) => e.type === 'custom' && e.customType === 'image-input-fixture',
        );
      });
      assert.deepEqual(inputRecord.data, [evidence]);
      const transformed = await call('send', {
        session_id: saved.id,
        text: 'TRANSFORM_IMAGE_TEST',
        images: [small],
      });
      assert.equal(transformed.status, route === 'rpc-host' ? 'started' : 'dispatched');
      if (route !== 'rpc-host') assert.equal(transformed.admission, 'unobservable');
      await until(async () => {
        const entries = sdk ? sdk.sessionManager.getEntries() : (await native.getEntries()).entries;
        return entries
          .findLast((e) => e.message?.role === 'user')
          ?.message.content.some((c) => c.type === 'text' && c.text === 'IMAGE_TRANSFORMED');
      });
      await until(
        async () =>
          (sdk ? sdk.getLastAssistantText() : await native.getLastAssistantText()) ===
          'IMAGE_CONTEXT:[]',
      );
      assert.equal((await status()).model.id, 'text-only');
      await call('send', { session_id: saved.id, text: 'SELECT_IMAGE_TEST', images: [small] });
      await until(
        async () =>
          (sdk ? sdk.getLastAssistantText() : await native.getLastAssistantText()) ===
          'IMAGE_CONTEXT:' + JSON.stringify([evidence]),
      );
      assert.equal((await status()).model.id, 'vision');
      // Missing capability fails before transport dispatch, never text-only fallback.
      const unsupported = new AttachedRuntime(config, saved, { ...record, imagesSupported: false });
      assert.throws(
        () => unsupported.send({ text: 'must not lose image', images: [image] }),
        /IMAGE_INPUT_UNSUPPORTED/,
      );
    },
  );
