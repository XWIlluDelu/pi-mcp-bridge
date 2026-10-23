import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { pngImage } from './fixtures/image-input.mjs';
import { createHttpService, TOKEN_HEADER } from '../src/http-server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, choice, savedEntries, completedEntries } from './fixtures/model-runtime.mjs';

test(
  'HTTP create selects the session model and preserves native defaults',
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
        requestInit: {
          headers: { [TOKEN_HEADER]: 'model-fixture-token-not-a-real-credential' },
        },
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

      model: choice('vision'),
      images: [pngImage()],
      text: 'VISION',
    };
    const made = await call('create', args);
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    assert.deepEqual(made.send.model_selection.model, choice('vision'));
    const snapshot = await completedEntries(bridge, made.session_id);
    assert.equal(snapshot.filter((e) => e.message?.role === 'user').length, 1);
    const reply = snapshot
      .findLast((e) => e.message?.role === 'assistant')
      .message.content.find((c) => c.type === 'text').text;
    assert.equal(JSON.parse(reply.slice('MODEL_INPUT:'.length)).id, 'vision');
    assert.equal(await fs.readFile(f.settings, 'utf8'), defaults);

    assert.equal((await bridge.sessions()).length, 2);
    assert.equal(
      (await savedEntries(bridge, made.session_id)).filter((e) => e.type === 'model_change').length,
      snapshot.filter((e) => e.type === 'model_change').length,
    );
    const sent = await call('send', {
      session_id: made.session_id,

      text: 'TEXT',
      model: choice('alpha'),
    });
    assert.ok(['started', 'queued', 'handled'].includes(sent.status), JSON.stringify(sent));
    const updated = await completedEntries(bridge, made.session_id);
    assert.equal(
      JSON.parse(
        updated
          .findLast((e) => e.message?.role === 'assistant')
          .message.content[0].text.slice('MODEL_INPUT:'.length),
      ).id,
      'alpha',
    );
  },
);

test(
  'busy model requests cannot change current or queued work; concurrent selected sends have one admission lane',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const first = await bridge.send({ session_id: id, text: 'HOLD_MODEL' });
    assert.ok(['started', 'queued', 'handled'].includes(first.status), JSON.stringify(first));
    let runtime = bridge.pool.get(id);
    assert.equal(
      (
        await bridge.send({
          session_id: id,

          text: 'QUEUED',
          mode: 'follow_up',
        })
      ).status,
      'queued',
    );
    for (const mode of ['default', 'idle_only', 'steer', 'follow_up']) {
      const result = await bridge.send({
        session_id: id,

        text: 'MUST_NOT_RUN',
        model: choice('vision'),
        mode,
      });
      assert.equal(result.status, mode === 'idle_only' ? 'skipped' : 'rejected');
      assert.equal(result.reason, mode === 'idle_only' ? 'busy' : 'MODEL_SELECTION_BUSY');
    }
    assert.equal((await runtime.state()).model.id, 'alpha');
    await fs.writeFile(f.gate, 'go');
    const entries = await completedEntries(bridge, id);
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
    await bridge.pool.resolve(await bridge.session(id));
    runtime = bridge.pool.get(id);
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

      text: 'HOLD_MODEL',
      model: choice('vision'),
    });
    await ready; // First selection has run, but its prompt has not yet been written.
    const b = bridge.send({
      session_id: id,

      text: 'MUST_NOT_RUN',
      model: choice('alpha'),
    });
    release();
    assert.ok(
      ['started', 'queued', 'handled'].includes((await a).status),
      'Expected native prompt admission',
    );
    assert.equal((await b).reason, 'MODEL_SELECTION_BUSY');
    assert.equal((await runtime.state()).model.id, 'vision');
    await fs.writeFile(f.gate, 'go');
    await completedEntries(bridge, id);
  },
);

test(
  'unavailable models and image-incompatible choices retain partial create identity',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const args = {
      project: f.cwd,

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

    assert.equal((await bridge.sessions()).length, 2);
    const rejected = await bridge.send({
      session_id: id,

      images: [pngImage()],
      model: choice('alpha'),
    });
    assert.equal(rejected.reason, 'MODEL_IMAGE_INPUT_UNSUPPORTED');
    assert.equal(rejected.model_selection, undefined);
    await assert.rejects(
      bridge.send({ session_id: id, model: choice('vision') }),
      /INVALID_ARGUMENTS/,
    );
  },
);
