import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { modelInfo, modelPage, cleanModelPage } from '../src/models.mjs';
import { AttachedRuntime } from '../src/attachments.mjs';
import { publicSchemas } from '../src/tool-schemas.mjs';
import { pngImage } from './fixtures/image-input.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, idle, until, choice } from './fixtures/model-runtime.mjs';

test('an owned RPC observer advertises no model endpoint it cannot serve', async (t) => {
  const { bridge, id } = await fixture(t);
  await bridge.models({ session_id: id, start: true });
  const runtime = bridge.pool.get(id);
  assert.notEqual(runtime.ownerRecord.modelsSupported, true);
  const observer = new AttachedRuntime(runtime.config, runtime.session, runtime.ownerRecord);
  await assert.rejects(observer.models(), /MODELS_UNSUPPORTED/);
});

test('model metadata allowlist preserves unknown, native unsupported and thinking levels without configuration', () => {
  const secret = {
    provider: 'p',
    id: 'm',
    name: 'Name',
    input: ['text'],
    reasoning: false,
    contextWindow: 16000,
    maxTokens: 2048,
    headers: { Authorization: 'SECRET' },
    apiKey: 'SECRET',
    baseUrl: 'SECRET',
    cost: { input: 0 },
    compat: { secret: 'SECRET' },
  };
  const page = modelPage([secret], secret, 'off');
  assert.deepEqual(page.models[0].thinking_levels, ['off']);
  assert.equal(page.models[0].supports_images, false);
  assert.ok(!JSON.stringify(page).includes('SECRET'));
  const unknown = modelInfo({ provider: 'p', id: 'unknown' });
  assert.equal(unknown.supports_images, null);
  assert.equal(unknown.reasoning, null);
  assert.equal(unknown.thinking_levels, null);
  assert.equal(unknown.context_window, null);
  assert.ok(
    !JSON.stringify(
      cleanModelPage({
        ...page,
        secret: 'SECRET',
        models: [{ ...page.models[0], headers: secret.headers }],
      }),
    ).includes('SECRET'),
  );
  assert.equal(
    publicSchemas.send.safeParse({
      session_id: 's',
      request_id: 'r',
      text: 'x',
      model: { provider: 'p', id: 'm', apiKey: 'secret' },
    }).success,
    false,
  );
});

test(
  'runtime model discovery is paged, authorized and never conflates inactive sessions with a catalog',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const inactive = await bridge.models({ session_id: id });
    assert.equal(inactive.source, 'inactive');
    assert.equal(inactive.models, null);
    assert.equal(inactive.model_selection, 'unknown');
    assert.equal(inactive.prompt_model_selection, 'unknown');
    assert.equal(bridge.pool.instances.size, 0);
    const live = await bridge.models({ session_id: id, start: true, limit: 1 });
    assert.equal(live.source, 'runtime');
    assert.equal(live.current.id, 'alpha');
    assert.equal(live.models.length, 1);
    assert.equal(live.next_offset, 1);
    const rest = await bridge.models({ session_id: id, offset: 1 });
    assert.ok(rest.models.some((m) => m.provider === 'model-fixture' && m.id === 'vision'));
    assert.equal(
      (await bridge.pool.get(id).entries()).entries.filter((e) => e.message?.role === 'user')
        .length,
      0,
    );
    const changed = { ...f.config, grants: [{ folder: f.cwd, read: true, list: true }] };
    await fs.writeFile(f.configFile, JSON.stringify(changed));
    await assert.rejects(bridge.models({ session_id: id }), /NOT_FOUND_OR_DENIED/);
  },
);

test(
  'HTTP create selects session model, preserves defaults, and replays without another child, prompt or switch',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge } = f;
    const service = createHttpService(bridge, {
        token: 'model-fixture-token-not-a-real-credential',
      }),
      url = await service.listen();
    const client = new Client({ name: 'model-test', version: '1' });
    t.after(async () => {
      await client.close();
      await service.close();
    });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { [TOKEN_HEADER]: 'model-fixture-token-not-a-real-credential' } },
      }),
    );
    const call = async (name, args) => {
      const r = await client.callTool({ name, arguments: args });
      assert.ok(!r.isError, JSON.stringify(r));
      return r.structuredContent;
    };
    const defaults = await fs.readFile(f.settings, 'utf8');
    const args = {
      project: f.cwd,
      request_id: 'create-vision',
      model: choice('vision'),
      images: [pngImage()],
      text: 'VISION',
    };
    const made = await call('create', args);
    assert.equal(made.status, 'accepted');
    assert.equal(made.send.model_selection.status, 'selected');
    const runtime = bridge.pool.get(made.session_id);
    await idle(runtime);
    const snapshot = await runtime.entries();
    assert.equal(snapshot.entries.filter((e) => e.message?.role === 'user').length, 1);
    const reply = (await runtime.command({ type: 'get_last_assistant_text' })).text;
    assert.equal(JSON.parse(reply.slice('MODEL_INPUT:'.length)).id, 'vision');
    assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);
    assert.deepEqual(await call('create', { project: f.cwd, request_id: args.request_id }), made);
    assert.deepEqual(await call('create', args), made);
    await assert.rejects(bridge.create({ ...args, model: choice('alpha') }), /REQUEST_ID_CONFLICT/);
    assert.equal((await bridge.sessions()).length, 2);
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.type === 'model_change').length,
      snapshot.entries.filter((e) => e.type === 'model_change').length,
    );
    const page = await call('models', { session_id: made.session_id });
    assert.equal(page.current.id, 'vision');
    const sent = await call('send', {
      session_id: made.session_id,
      request_id: 'back-to-text',
      text: 'TEXT',
      model: choice('alpha'),
    });
    assert.equal(sent.status, 'accepted');
    await idle(runtime);
    assert.equal((await runtime.state()).model.id, 'alpha');
    // Replay the old create must not restore its previous selection.
    assert.deepEqual(await call('create', args), made);
    assert.equal((await runtime.state()).model.id, 'alpha');
    assert.equal((await call('models', { session_id: f.id, start: true })).current.id, 'alpha');
    const maintenance = await call('batch', {
      operations: [
        {
          op: 'set_model',
          args: {
            session_id: made.session_id,
            request_id: 'batch-thinking',
            thinking_level: 'off',
          },
        },
        { op: 'models', args: { session_id: made.session_id } },
        { op: 'reload', args: { session_id: made.session_id, request_id: 'batch-reopen' } },
      ],
    });
    assert.equal(maintenance.results[0].result.thinking_level, 'off');
    assert.equal(maintenance.results[1].result.current.id, 'alpha');
    assert.equal(maintenance.results[2].result.status, 'accepted');
    assert.equal(maintenance.results[2].result.method, 'rpc_reopen');
  },
);

test(
  'busy model requests cannot change current or queued work; concurrent selected sends have one admission lane',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const first = await bridge.send({ session_id: id, request_id: 'held', text: 'HOLD_MODEL' });
    assert.equal(first.status, 'accepted');
    const runtime = bridge.pool.get(id);
    assert.equal(
      (
        await bridge.send({
          session_id: id,
          request_id: 'queued',
          text: 'QUEUED',
          mode: 'follow_up',
        })
      ).disposition,
      'queued',
    );
    for (const mode of ['default', 'idle_only', 'steer', 'follow_up']) {
      const result = await bridge.send({
        session_id: id,
        request_id: 'busy-' + mode,
        text: 'MUST_NOT_RUN',
        model: choice('vision'),
        mode,
      });
      assert.equal(result.status, mode === 'idle_only' ? 'skipped' : 'rejected');
      assert.equal(result.reason, mode === 'idle_only' ? 'busy' : 'MODEL_SELECTION_BUSY');
    }
    assert.equal((await runtime.state()).model.id, 'alpha');
    await fs.writeFile(f.gate, 'go');
    await idle(runtime);
    const entries = (await runtime.entries()).entries;
    assert.equal(entries.filter((e) => e.message?.role === 'user').length, 2);
    assert.ok(
      entries
        .filter((e) => e.message?.role === 'assistant')
        .every(
          (e) =>
            JSON.parse(
              e.message.content.find((b) => b.type === 'text').text.slice('MODEL_INPUT:'.length),
            ).id === 'alpha',
        ),
    );
    await fs.rm(f.gate);
    let entered, release;
    const ready = new Promise((r) => (entered = r)),
      gate = new Promise((r) => (release = r)),
      command = runtime.command.bind(runtime);
    runtime.command = async (input, ...rest) => {
      if (input.type === 'prompt' && input.message === 'HOLD_MODEL') {
        entered();
        await gate;
      }
      return command(input, ...rest);
    };
    const a = bridge.send({
      session_id: id,
      request_id: 'switch-and-hold',
      text: 'HOLD_MODEL',
      model: choice('vision'),
    });
    await ready; // First selection has run, but its prompt has not yet been written.
    const b = bridge.send({
      session_id: id,
      request_id: 'competing-switch',
      text: 'MUST_NOT_RUN',
      model: choice('alpha'),
    });
    release();
    assert.equal((await a).status, 'accepted');
    assert.equal((await b).reason, 'MODEL_SELECTION_BUSY');
    assert.equal((await runtime.state()).model.id, 'vision');
    await fs.writeFile(f.gate, 'go');
    await idle(runtime);
  },
);

test(
  'unavailable models, image-incompatible choices and partial create recovery never repeat work',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const args = {
      project: f.cwd,
      request_id: 'unavailable-child',
      text: 'NEVER',
      model: choice('absent'),
    };
    const made = await bridge.create(args);
    assert.equal(made.created, true);
    assert.equal(made.send.status, 'rejected');
    assert.equal(made.send.reason, 'MODEL_UNAVAILABLE');
    const runtime = bridge.pool.get(made.session_id);
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
      0,
    );
    assert.deepEqual(await bridge.create({ project: f.cwd, request_id: args.request_id }), made);
    await assert.rejects(
      bridge.create({ ...args, model: choice('vision') }),
      /REQUEST_ID_CONFLICT/,
    );
    assert.equal((await bridge.sessions()).length, 2);
    const rejected = await bridge.send({
      session_id: id,
      request_id: 'text-model-image',
      images: [pngImage()],
      model: choice('alpha'),
    });
    assert.equal(rejected.reason, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
    assert.equal(rejected.model_selection.status, 'not_changed');
    await assert.rejects(
      bridge.send({ session_id: id, request_id: 'model-only', model: choice('vision') }),
      /MODEL_REQUIRES_PROMPT/,
    );
  },
);
