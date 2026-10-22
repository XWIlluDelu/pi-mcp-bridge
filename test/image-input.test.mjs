import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { imagesSchema, promptInput, MAX_IMAGE_BYTES } from '../src/prompt-input.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
import { toolDefinitions, META, MODERN_VERSION } from '../src/protocol.mjs';
import { Bridge } from '../src/bridge.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { pngImage, imageEvidence } from './fixtures/image-input.mjs';
import { savedEntries } from './fixtures/saved-session.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await pause(10);
  }
  throw Error('IMAGE_TEST_TIMEOUT');
}
const parseEvidence = (text) => JSON.parse(text.slice('IMAGE_CONTEXT:'.length));
const lastText = (entries) =>
  entries
    .findLast((e) => e.message?.role === 'assistant')
    .message.content.find((c) => c.type === 'text').text;
const token = 'synthetic-image-test-token-not-a-real-credential';

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
  for (const count of [5, 33, 100])
    assert.equal(imagesSchema.safeParse(Array(count).fill(image)).success, true);
  const invalid = [
    [],
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

test(
  'HTTP create/send/batch and fork retain native image identity',
  { timeout: 90000 }, // Multiple cold starts and two near-limit image round trips.
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-image-http-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const config = {
      ...isolatedRuntime(dir),
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: cwd }],
      grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
    };
    await fs.mkdir(config.piRuntime.agentDir, { recursive: true });
    await fs.writeFile(
      path.join(config.piRuntime.agentDir, 'settings.json'),
      JSON.stringify({
        images: { autoResize: false },
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
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
    const bridge = await new Bridge(config).init(),
      service = createHttpService(bridge, { token }),
      url = await service.listen();
    const client = new Client({ name: 'image-http', version: '1' });
    t.after(async () => {
      await client.close();
      await service.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { [TOKEN_HEADER]: token } },
      }),
    );
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent;
    };
    const completed = async (id) => {
      await until(async () => (await bridge.pool.get(id).idleSnapshot()).status === 'idle');
      return savedEntries(bridge, id);
    };
    const image = pngImage(),
      changed = pngImage(),
      initial = { project: cwd, images: [image] };
    const made = await call('create', initial);
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    const entries = await completed(made.session_id);
    assert.deepEqual(parseEvidence(lastText(entries)), [imageEvidence(image)]);
    assert.deepEqual(
      entries
        .find((e) => e.message?.role === 'user')
        .message.content.filter((c) => c.type === 'image'),
      [image],
    );

    for (const mode of ['default', 'idle_only', 'steer', 'follow_up']) {
      const args = {
        session_id: made.session_id,

        text: mode,
        images: mode === 'follow_up' ? Array(40).fill(image) : [image],
        mode,
      };
      const sent = await call('send', args);
      assert.ok(['started', 'queued', 'handled'].includes(sent.status), JSON.stringify(sent));
      const current = await completed(made.session_id);
      assert.deepEqual(parseEvidence(lastText(current)), args.images.map(imageEvidence));
    }
    const fork = await call('create', {
      project: cwd,

      fork_from: made.session_id,
      text: 'child',
      images: [changed],
    });
    assert.ok(['started', 'queued', 'handled'].includes(fork.status), JSON.stringify(fork));
    const child = await completed(fork.session_id);
    assert.deepEqual(parseEvidence(lastText(child)), [imageEvidence(changed)]);
    assert.equal(
      (await bridge.session(fork.session_id)).header.parentSession,
      (await bridge.session(made.session_id)).file,
    );
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: token,
        'content-type': 'application/json',
        accept: 'application/json',
        'MCP-Protocol-Version': MODERN_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'batch',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: {
          _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
          name: 'batch',
          arguments: {
            operations: [
              {
                op: 'send',
                args: {
                  session_id: made.session_id,

                  images: [changed],
                },
              },
              { op: 'health', args: {} },
            ],
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const batch = (await response.json()).result.structuredContent;
    assert.equal(batch.results[0].result.status, 'started');
    const finalEntries = await completed(made.session_id);
    assert.deepEqual(parseEvidence(lastText(finalEntries)), [imageEvidence(changed)]);
    const page = await call('read', {
      session_id: made.session_id,
      preset: 'full',
      max_bytes: 65536,
    });
    assert.ok(!JSON.stringify(page).includes(image.data));
    const descriptor = page.items
      .flatMap((item) => item.message?.content ?? [])
      .find((block) => block.type === 'image');
    assert.deepEqual(descriptor, { type: 'image', mime_type: image.mimeType, data_omitted: true });
    const owners = bridge.pool.instances.size;
    const invalid = await client.callTool({
      name: 'send',
      arguments: {
        session_id: made.session_id,

        images: [{ ...image, mimeType: 'image/jpeg' }],
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(bridge.pool.instances.size, owners);
    const denied = await call('send', {
      session_id: made.session_id,

      model: { provider: 'image-fixture', id: 'text-only' },
      images: [image],
    });
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.reason, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
    const large = pngImage(1126, 1126),
      evidence = imageEvidence(large);
    assert.ok(evidence.bytes < MAX_IMAGE_BYTES);
    assert.ok(Buffer.byteLength(large.data) > 6100000);
    const largeArgs = { session_id: made.session_id, images: [large] };
    const direct = await call('send', largeArgs);
    assert.equal(direct.status, 'started');
    assert.deepEqual(parseEvidence(lastText(await completed(made.session_id))), [evidence]);
    const batched = await call('batch', { operations: [{ op: 'send', args: largeArgs }] });
    assert.equal(batched.results[0].result.status, 'started', JSON.stringify(batched));
    assert.deepEqual(parseEvidence(lastText(await completed(made.session_id))), [evidence]);
    const before = await fs.stat((await bridge.session(made.session_id)).file);
    const oversized = await fetch(url, {
      method: 'POST',
      headers: {
        [TOKEN_HEADER]: token,
        'content-type': 'application/json',
        accept: 'application/json',
        'MCP-Protocol-Version': MODERN_VERSION,
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'batch',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'batch',
          arguments: {
            operations: [
              { op: 'send', args: largeArgs },
              { op: 'send', args: largeArgs },
            ],
          },
          _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
        },
      }),
    });
    assert.equal(oversized.status, 413);
    await oversized.arrayBuffer();
    assert.equal(bridge.pool.instances.size, owners);
    assert.equal((await fs.stat((await bridge.session(made.session_id)).file)).size, before.size);
  },
);
