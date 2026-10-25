import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { pngImage } from './fixtures/image-input.mjs';
import { savedEntries } from './fixtures/saved-session.mjs';

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(10);
  }
  throw Error('IMAGE_QUEUE_TIMEOUT');
}
test(
  'busy steering and follow-up retain images; idle-only skips and restart replays without work',
  { timeout: 20000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-image-queues-'),
      cwd = path.join(dir, 'project'),
      gate = path.join(dir, 'release');
    await fs.mkdir(cwd);
    const prior = process.env.PI_IMAGE_TEST_GATE;
    process.env.PI_IMAGE_TEST_GATE = gate;
    const config = {
      ...isolatedRuntime(dir),
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: cwd }],
      grants: [{ folder: cwd, read: true, send: true, create: true }],
    };
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
    let bridge = await new Bridge(config).init();
    t.after(async () => {
      await fs.writeFile(gate, 'done');
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
      if (prior === undefined) delete process.env.PI_IMAGE_TEST_GATE;
      else process.env.PI_IMAGE_TEST_GATE = prior;
    });
    const made = await bridge.create({ project: cwd, text: 'HOLD_IMAGE_TEST' }),
      runtime = bridge.pool.get(made.session_id);
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    await until(async () => (await runtime.state()).isStreaming);
    const follow = pngImage(),
      steer = pngImage(),
      skipped = pngImage();
    const args = {
      session_id: made.session_id,

      mode: 'follow_up',
      images: [follow],
    };
    const queued = await bridge.send(args);
    assert.ok(['started', 'queued', 'handled'].includes(queued.status), JSON.stringify(queued));
    assert.equal(queued.status, 'queued');
    const steering = await bridge.send({
      session_id: made.session_id,

      images: [steer],
    });
    assert.ok(['started', 'queued', 'handled'].includes(steering.status), JSON.stringify(steering));
    assert.equal(steering.status, 'queued');
    assert.equal(
      (
        await bridge.send({
          session_id: made.session_id,

          mode: 'idle_only',
          images: [skipped],
        })
      ).status,
      'skipped',
    );
    await fs.writeFile(gate, 'done');
    await until(() => runtime.exited && !bridge.autoReleases.size);
    const images = (await savedEntries(bridge, made.session_id))
      .filter((e) => e.message?.role === 'user')
      .flatMap((e) =>
        Array.isArray(e.message.content) ? e.message.content.filter((c) => c.type === 'image') : [],
      );
    assert.deepEqual(images, [steer, follow]);
    const before = await fs.readFile((await bridge.session(made.session_id)).file, 'utf8');
    await bridge.close();
    bridge = await new Bridge(config, () => {
      throw Error('REPLAY_STARTED_WRITER');
    }).init();

    assert.equal(await fs.readFile((await bridge.session(made.session_id)).file, 'utf8'), before);
  },
);
