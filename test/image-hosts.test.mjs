import { until } from './fixtures/until.mjs';
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
import { Bridge } from '../src/bridge.mjs';
import { processIdentity, readClaim, ownerAlive } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { pngImage, imageEvidence } from './fixtures/image-input.mjs';
import { imageReply, imageInputExtension } from './fixtures/image-provider.mjs';

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
      let native, controller, sdk;
      t.after(async () => {
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
          models: [{ id: 'vision', input: ['text', 'image'] }],
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
      // Incompressible real PNG exceeds the old 1 MiB IPC request bound.
      const image = pngImage(520, 520);
      assert.ok(Buffer.byteLength(image.data) > 1024 * 1024);
      const sent = await bridge.send({
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
      assert.equal((await readClaim(config.attachmentDir, saved)).generation, record.generation);
      assert.equal(spawned, 0);
    },
  );
