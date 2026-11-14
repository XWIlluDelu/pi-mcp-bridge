import { until } from './fixtures/until.mjs';

import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { imagesSchema, promptInput, MAX_IMAGE_BYTES, MAX_IMAGES } from '../src/prompt-input.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
import { toolDefinitions } from '../src/protocol.mjs';
import { Bridge } from '../src/bridge.mjs';

import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { pngImage, imageEvidence } from './fixtures/image-input.mjs';
import { savedEntries } from './fixtures/saved-session.mjs';

const parseEvidence = (text) => JSON.parse(text.slice('IMAGE_CONTEXT:'.length));
const lastText = (entries) =>
  entries
    .findLast((e) => e.message?.role === 'assistant')
    .message.content.find((c) => c.type === 'text').text;

test('image schemas expose native blocks and reject malformed, mislabeled and oversized data', () => {
  const image = pngImage();
  for (const tool of ['send', 'create']) {
    const identity = tool === 'send' ? { session_id: 'session' } : { project: '/project' };
    assert.ok(publicSchemas[tool].safeParse({ ...identity, images: [image] }).success);
    assert.ok(toolDefinitions().find((t) => t.name === tool).inputSchema.properties.images);
  }
  assert.deepEqual(promptInput({ images: [image] }), {
    text: '[Image attachment]',
    images: [image],
  });
  assert.equal(promptInput({}), undefined);
  for (const count of [1, MAX_IMAGES])
    assert.equal(imagesSchema.safeParse(Array(count).fill(image)).success, true);
  const invalid = [
    [],
    Array(MAX_IMAGES + 1).fill(image),
    [{ ...image, data: 'data:image/png;base64,' + image.data }],
    [{ ...image, data: image.data + '\n' }],
    [{ ...image, data: 'not base64' }],
    [{ ...image, mimeType: 'image/jpeg' }],
    [{ ...image, mimeType: 'image/svg+xml' }],
    [{ type: 'image', mimeType: 'image/png', url: 'https://example.com/a.png' }],
  ];
  for (const images of invalid) assert.equal(imagesSchema.safeParse(images).success, false);
  const large = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  Buffer.from(image.data, 'base64').subarray(0, 8).copy(large);
  assert.equal(
    imagesSchema.safeParse([{ ...image, data: large.toString('base64') }]).success,
    false,
  );
  const half = large.subarray(0, 3 * 1024 * 1024);
  assert.equal(
    imagesSchema.safeParse(Array(2).fill({ ...image, data: half.toString('base64') })).success,
    false,
  );
});

test('owned RPC create/send preserve image handling, transformation and native model selection', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-image-hooks-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [{ folder: cwd, read: true, send: true, create: true }],
  };
  config.piArgs.push(
    '--no-extensions',
    '-e',
    path.resolve('test/fixtures/image-provider.mjs'),
    '--provider',
    'image-fixture',
    '--model',
    'text-only',
    '--thinking',
    'off',
  );
  const bridge = await new Bridge(config).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const image = pngImage(),
    evidence = imageEvidence(image);
  const model = { provider: 'image-fixture', id: 'text-only' };
  const made = await bridge.create({
    project: cwd,
    model,
    text: 'HANDLE_IMAGE_TEST ' + evidence.sha256,
    images: [image],
  });
  assert.equal(made.created, true);
  assert.equal(made.send.status, 'handled', JSON.stringify(made));
  await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
  const handled = await bridge.send({
    session_id: made.session_id,
    model,
    text: 'HANDLE_IMAGE_TEST ' + evidence.sha256,
    images: [image],
  });
  assert.equal(handled.status, 'handled', JSON.stringify(handled));
  await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
  const transformed = await bridge.send({
    session_id: made.session_id,
    model,
    text: 'TRANSFORM_IMAGE_TEST',
    images: [image],
  });
  assert.equal(transformed.status, 'started', JSON.stringify(transformed));
  await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
  const entries = await savedEntries(bridge, made.session_id);
  assert.equal(lastText(entries), 'IMAGE_CONTEXT:[]');
  assert.deepEqual(entries.findLast((e) => e.message?.role === 'user').message.content, [
    { type: 'text', text: 'IMAGE_TRANSFORMED' },
  ]);
  const selected = await bridge.send({
    session_id: made.session_id,
    model,
    text: 'SELECT_IMAGE_TEST',
    images: [image],
  });
  assert.equal(selected.status, 'started', JSON.stringify(selected));
  await until(() => !bridge.pool.get(made.session_id) && !bridge.autoReleases.size);
  const final = await savedEntries(bridge, made.session_id);
  assert.deepEqual(parseEvidence(lastText(final)), [evidence]);
  assert.equal(final.findLast((e) => e.message?.role === 'assistant').message.model, 'vision');
});
