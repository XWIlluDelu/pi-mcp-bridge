import test from 'node:test';
import assert from 'node:assert/strict';

import { modelInfo as nativeModelInfo } from '../src/ops/models.mjs';
import { getSupportedThinkingLevels } from './fixtures/pi.mjs';
const modelInfo = (model) => nativeModelInfo(model, getSupportedThinkingLevels);
import { publicSchemas } from '../src/mcp/tool-schemas.mjs';

import { fixture, choice } from './fixtures/model-runtime.mjs';
import { assertInvalidArguments } from './fixtures/tool-call.mjs';

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
    inputLimits: { maxRequestBytes: 10000, images: { maxPerMessage: 2, maxPerRequest: 4 } },
  };
  const info = modelInfo(secret);
  assert.deepEqual(info, {
    provider: 'p',
    id: 'm',
    name: 'Name',
    input: ['text'],
    context_window: 16000,
    thinking_levels: ['off'],
  });
  assert.deepEqual(
    modelInfo({ ...secret, reasoning: true }).thinking_levels,
    getSupportedThinkingLevels({ ...secret, reasoning: true }),
  );
  assert.ok(!JSON.stringify(info).includes('SECRET'));
  const unknown = modelInfo({ provider: 'p', id: 'unknown' });
  assert.equal(unknown.input, null);
  assert.equal(unknown.thinking_levels, null);
  assert.equal(unknown.context_window, null);
  assert.equal(
    publicSchemas.send.safeParse({
      session_id: 's',
      text: 'x',
      model: { provider: 'p', id: 'm', apiKey: 'secret' },
    }).success,
    false,
  );
});

test(
  'unavailable models retain partial create identity and settings require a prompt',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id } = f;
    const args = {
      project: f.cwd,
      text: 'NEVER',
      model: choice('absent'),
    };
    const made = await bridge.create_session(args);
    assert.equal(made.created, true);
    assert.equal(made.send.status, 'rejected');
    assert.equal(made.send.reason, 'MODEL_UNAVAILABLE');
    const runtime = bridge.pool.get(made.session_id);
    assert.equal(
      (await runtime.entries()).entries.filter((e) => e.message?.role === 'user').length,
      0,
    );

    assert.equal((await bridge.sessions()).length, 2);
    await assertInvalidArguments(bridge, 'send', { session_id: id, model: choice('vision') });
  },
);
