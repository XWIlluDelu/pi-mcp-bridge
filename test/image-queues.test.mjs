import { until } from './fixtures/until.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { pngImage } from './fixtures/image-input.mjs';
import { savedEntries } from './fixtures/saved-session.mjs';

test(
  'busy steering and follow-up retain images; idle-only skips and restart replays without work',
  { timeout: 20000 },
  async (t) => {
    const f = await nativeOwner(t, {
      prefix: 'image-queues',
      seed: false,
      configure({ dir, config, cleanup }) {
        const prior = process.env.PI_IMAGE_TEST_GATE;
        process.env.PI_IMAGE_TEST_GATE = path.join(dir, 'release');
        t.after(() => {
          if (prior === undefined) delete process.env.PI_IMAGE_TEST_GATE;
          else process.env.PI_IMAGE_TEST_GATE = prior;
        });
        cleanup.push(() => fs.writeFile(path.join(dir, 'release'), 'done'));
        config.piRuntime.inheritEnv.push('PI_IMAGE_TEST_GATE');
        config.piArgs.push(
          '-e',
          path.resolve('test/fixtures/image-provider.mjs'),
          '--provider',
          'image-fixture',
          '--model',
          'vision',
          '--thinking',
          'off',
        );
      },
    });
    const { bridge, cwd, config } = f;
    const made = await bridge.create({ project: cwd, text: 'HOLD_IMAGE_TEST' }),
      runtime = bridge.pool.get(made.session_id);
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    await until(async () => (await runtime.state()).isStreaming);
    const follow = pngImage(),
      steer = pngImage(),
      skipped = pngImage();
    for (const [mode, image, status] of [
      ['follow_up', follow, 'queued'],
      ['steer', steer, 'queued'],
      ['idle_only', skipped, 'skipped'],
    ])
      assert.equal(
        (await bridge.send({ session_id: made.session_id, mode, images: [image] })).status,
        status,
      );
    await f.mark('release');
    await until(() => runtime.exited && !bridge.autoReleases.size);
    const images = (await savedEntries(bridge, made.session_id))
      .filter((e) => e.message?.role === 'user')
      .flatMap((e) =>
        Array.isArray(e.message.content) ? e.message.content.filter((c) => c.type === 'image') : [],
      );
    assert.deepEqual(images, [steer, follow]);
    const before = await fs.readFile((await bridge.session(made.session_id)).file, 'utf8');
    await bridge.close();
    const reopened = await new Bridge(config, () => {
      throw Error('REPLAY_STARTED_WRITER');
    }).init();

    f.cleanup.push(() => reopened.close());
    assert.equal(await fs.readFile((await reopened.session(made.session_id)).file, 'utf8'), before);
  },
);
