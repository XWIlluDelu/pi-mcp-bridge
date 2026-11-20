import { nativeOwner } from './fixtures/native-owner.mjs';
import { releasedEntries } from './fixtures/model-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  imagesSchema,
  promptInput,
  MAX_IMAGE_BYTES,
  MAX_IMAGES,
} from '../src/ops/prompt-input.mjs';
import { publicSchemas } from '../src/mcp/tool-schemas.mjs';
import { toolDefinitions } from '../src/mcp/protocol.mjs';

import { pngImage, imageEvidence } from './fixtures/image-input.mjs';

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
  const { bridge, cwd } = await nativeOwner(t, {
    prefix: 'image-input',
    seed: false,
    configure({ config }) {
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
    },
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
  const id = made.session_id;
  await releasedEntries(bridge, id);
  const send = (text) => bridge.send({ session_id: id, model, text, images: [image] });
  assert.equal((await send('TRANSFORM_IMAGE_TEST')).status, 'started');
  const entries = await releasedEntries(bridge, id);
  assert.equal(lastText(entries), 'IMAGE_CONTEXT:[]');
  assert.deepEqual(entries.findLast((e) => e.message?.role === 'user').message.content, [
    { type: 'text', text: 'IMAGE_TRANSFORMED' },
  ]);
  assert.equal((await send('SELECT_IMAGE_TEST')).status, 'started');
  const final = await releasedEntries(bridge, id);
  assert.deepEqual(parseEvidence(lastText(final)), [evidence]);
  assert.equal(final.findLast((e) => e.message?.role === 'assistant').message.model, 'vision');
});
