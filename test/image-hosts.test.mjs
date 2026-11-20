import { nativeOwner, launchNativeTui } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { nativeRpc, nativeRpcHost } from './fixtures/native-rpc.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { loadSavedSession } from '../src/core/data.mjs';
import { offlineModels, sdkSession } from './fixtures/native-sdk.mjs';
import { fauxProvider } from './fixtures/pi.mjs';
import { readClaim } from '../src/runtime/attachments.mjs';
import { reserveHostSession } from '../src/runtime/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/runtime/host-bindings.mjs';
import { pngImage, imageEvidence } from './fixtures/image-input.mjs';
import { imageReply, imageInputExtension } from './fixtures/image-provider.mjs';

for (const route of ['rpc-host', 'companion', 'tui-companion', 'sdk-host'])
  test(
    'native images reach provider through ' + route + ' without a second writer',
    { timeout: 20000 },
    async (t) => {
      const settingsValue = {
        images: { autoResize: false },
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      };
      const f = await nativeOwner(t, {
        prefix: 'image-host',
        factory: () => assert.fail('Unexpected second writer'),
        configure: ({ config }) =>
          fs.writeFile(
            path.join(config.piRuntime.agentDir, 'settings.json'),
            JSON.stringify(settingsValue),
          ),
      });
      const { config, bridge, session: saved } = f;
      let native, sdk;
      if (route === 'sdk-host') {
        const controller = await reserveHostSession({
          buildSessionProjection: hostProjection,
          attachmentDir: config.attachmentDir,
          session: saved,
        });
        f.cleanup.push(() => controller.close());
        const faux = fauxProvider({
          provider: 'image-sdk',
          models: [{ id: 'vision', input: ['text', 'image'] }],
          tokensPerSecond: 10000,
        });
        faux.setResponses(Array.from({ length: 10 }, () => imageReply));
        sdk = await sdkSession(f, await offlineModels(faux), faux.getModel(), {
          settings: settingsValue,
          extensions: [imageInputExtension],
        });
        f.cleanup.push(async () => {
          await sdk.abort();
          sdk.dispose();
        });
        await sdk.bindExtensions({ mode: 'rpc' });
        await controller.ready(createSdkHostBinding(sdk));
      } else {
        const nativeOptions = {
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
          ],
        };
        if (route.endsWith('companion'))
          nativeOptions.args.push(
            '--session',
            saved.file,
            '-e',
            path.resolve('src/attach-extension.mjs'),
          );
        if (route === 'tui-companion') {
          const tui = launchNativeTui(f, [
            ...nativeOptions.args,
            '--provider',
            'image-fixture',
            '--model',
            'vision',
            '--thinking',
            'off',
          ]);
          await tui.ready(saved);
        } else if (route === 'rpc-host') {
          const { client, controller } = await nativeRpcHost(f, nativeOptions);
          native = client;
          await controller.ready(createRpcHostBinding(native));
        } else {
          native = await nativeRpc(f, nativeOptions);
          await native.getState();
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
        const value = sdk
          ? sdk.getLastAssistantText()
          : native
            ? await native.getLastAssistantText()
            : (await loadSavedSession(saved)).entries
                .findLast((e) => e.message?.role === 'assistant')
                ?.message.content.find((block) => block.type === 'text')?.text;
        return value?.startsWith('IMAGE_CONTEXT:') && value;
      });
      assert.deepEqual(JSON.parse(text.slice('IMAGE_CONTEXT:'.length)), [imageEvidence(image)]);
      assert.equal((await readClaim(config.attachmentDir, saved)).generation, record.generation);
    },
  );
