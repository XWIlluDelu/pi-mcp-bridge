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
const token = 'synthetic-image-test-token-not-a-real-credential';

test('image schemas expose native blocks and reject malformed, mislabeled and oversized data', () => {
  const image = pngImage();
  for (const tool of ['send', 'create']) {
    const identity = tool === 'send' ? { session_id: 'session' } : { project: '/project' };
    assert.ok(
      publicSchemas[tool].safeParse({ ...identity, request_id: 'image-only', images: [image] })
        .success,
    );
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
  'HTTP create/send/batch deliver images to the native provider; replay, fork and recovery retain image identity',
  { timeout: 30000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-image-http-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const config = {
      ...isolatedRuntime(dir),
      principal: 'images',
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ id: 'project', path: cwd }],
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
    const image = pngImage(),
      changed = pngImage(),
      initial = { project: cwd, request_id: 'create-image', images: [image] };
    const made = await call('create', initial);
    assert.equal(made.status, 'accepted');
    const runtime = bridge.pool.get(made.session_id);
    await until(async () => !(await runtime.state()).isStreaming);
    assert.deepEqual(
      parseEvidence((await runtime.command({ type: 'get_last_assistant_text' })).text),
      [imageEvidence(image)],
    );
    const entries = (await runtime.entries()).entries;
    assert.deepEqual(
      entries
        .find((e) => e.message?.role === 'user')
        .message.content.filter((c) => c.type === 'image'),
      [image],
    );
    assert.deepEqual(await call('create', initial), made);
    assert.deepEqual(await call('create', { project: cwd, request_id: initial.request_id }), made);
    const conflict = await client.callTool({
      name: 'create',
      arguments: { ...initial, images: [changed] },
    });
    assert.equal(conflict.isError, true);
    assert.match(JSON.stringify(conflict), /REQUEST_ID_CONFLICT/);
    assert.equal((await bridge.sessions()).length, 1);
    for (const mode of ['default', 'idle_only', 'steer', 'follow_up']) {
      const args = {
        session_id: made.session_id,
        request_id: 'image-' + mode,
        text: mode,
        images: mode === 'follow_up' ? Array(40).fill(image) : [image],
        mode,
      };
      const sent = await call('send', args);
      assert.equal(sent.status, 'accepted');
      await until(async () => !(await runtime.state()).isStreaming);
      assert.deepEqual(
        parseEvidence((await runtime.command({ type: 'get_last_assistant_text' })).text),
        args.images.map(imageEvidence),
      );
      assert.deepEqual(
        await call('send', { session_id: made.session_id, request_id: args.request_id }),
        sent,
      );
    }
    const fork = await call('create', {
      project: cwd,
      request_id: 'image-fork',
      fork_from: made.session_id,
      text: 'child',
      images: [changed],
    });
    assert.equal(fork.status, 'accepted');
    const child = bridge.pool.get(fork.session_id);
    await until(async () => !(await child.state()).isStreaming);
    assert.deepEqual(
      parseEvidence((await child.command({ type: 'get_last_assistant_text' })).text),
      [imageEvidence(changed)],
    );
    assert.equal(
      (await runtime.state()).sessionId,
      (await bridge.session(made.session_id)).header.id,
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
                  request_id: 'modern-image',
                  images: [changed],
                },
              },
              { op: 'health', args: { domain: 'permissions' } },
            ],
          },
        },
      }),
    });
    assert.equal(response.status, 200);
    const batch = (await response.json()).result.structuredContent;
    assert.equal(batch.results[0].result.status, 'accepted');
    await until(async () => !(await runtime.state()).isStreaming);
    assert.deepEqual(
      parseEvidence((await runtime.command({ type: 'get_last_assistant_text' })).text),
      [imageEvidence(changed)],
    );
    const page = await call('read', { session_id: made.session_id, max_bytes: 65536 });
    assert.ok(JSON.stringify(page).includes(image.data));
    const invalid = await client.callTool({
      name: 'send',
      arguments: {
        session_id: made.session_id,
        request_id: 'bad-image',
        images: [{ ...image, mimeType: 'image/jpeg' }],
      },
    });
    assert.equal(invalid.isError, true);
    assert.equal(await bridge.journal.get('bad-image'), null);
    await runtime.command({ type: 'set_model', provider: 'image-fixture', modelId: 'text-only' });
    const denied = await call('send', {
      session_id: made.session_id,
      request_id: 'text-model',
      images: [image],
    });
    assert.equal(denied.status, 'rejected');
    assert.equal(denied.reason, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
  },
);
