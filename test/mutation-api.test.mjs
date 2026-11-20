import { AttachedRuntime } from '../src/runtime/attachments.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import { callBridgeTool } from '../src/mcp/protocol.mjs';
import { executeBatch } from '../src/mcp/batch.mjs';

import { nativeOwner } from './fixtures/native-owner.mjs';

function admissionReceipt(result) {
  const { submission_id, ...receipt } = result;
  assert.match(
    submission_id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  return receipt;
}

async function fixture(t) {
  const runtime = ownedRuntime({
    generation: 'fixture-generation',
    state: async () => ({ isStreaming: false }),
    command: () => assert.fail('Unexpected native dispatch'),
    selectModel: async (model, options) => ({
      model: model ?? { provider: 'fixture', id: 'native' },
      thinking_level: options.thinkingLevel ?? 'off',
    }),
  });
  const f = await nativeOwner(t, {
    prefix: 'mutation',
    factory: async () => runtime,
  });
  return { ...f, runtime };
}

test('launch failures preserve public codes through MCP and batch without exposing native error text', async (t) => {
  const f = await fixture(t);
  for (const code of [
    'HERDR_PROTOCOL_MISMATCH',
    'PI_INSTALLATION_UNAVAILABLE',
    'PRIVATE_PROVIDER_ERROR',
  ]) {
    f.bridge.pool.factory = async () => {
      throw Object.assign(new Error('private provider credentials'), { code });
    };
    const args = { session_id: f.id, text: 'NEVER_DISPATCHED' },
      expected = code === 'PRIVATE_PROVIDER_ERROR' ? 'OPERATION_FAILED' : code;
    assert.equal((await callBridgeTool(f.bridge, 'send', args)).structuredContent.reason, expected);
    assert.equal(
      (
        await executeBatch(f.bridge, {
          operations: [{ op: 'send', args }],
        })
      ).results[0].result.reason,
      expected,
    );
  }
});

test('send validates owner admission and returns only verified explicit settings', async (t) => {
  const f = await fixture(t),
    args = { session_id: f.id, text: 'input' };
  for (const disposition of ['started', 'queued', 'handled']) {
    f.runtime.command = async () => ({
      disposition,
      ui: { cancel_sent: ['confirm'], completion: 'unconfirmed' },
    });
    assert.deepEqual(admissionReceipt(await f.bridge.send(args)), {
      status: disposition,
      reason: 'EXTENSION_UI_CANCEL_SENT',
    });
  }
  for (const value of [{}, { status: 'accepted' }, { disposition: 'invented' }]) {
    f.runtime.command = async () => value;
    assert.deepEqual(admissionReceipt(await f.bridge.send(args)), {
      status: 'unknown',
      reason: 'INVALID_PROMPT_RESULT',
    });
  }
  f.runtime.command = async () => ({ disposition: 'started' });
  const model = { provider: 'fixture', id: 'chosen' };
  assert.deepEqual(
    admissionReceipt(await f.bridge.send({ ...args, model, thinking_level: 'high' })),
    {
      status: 'started',
      model_selection: { model, thinking_level: 'high' },
    },
  );
  f.runtime.selectModel = async () => {
    throw Object.assign(new Error('ACK_TIMEOUT'), { uncertain: true });
  };
  assert.deepEqual(admissionReceipt(await f.bridge.send({ ...args, model })), {
    status: 'unknown',
    reason: 'ACK_TIMEOUT',
  });
  t.mock.method(f.bridge.pool, 'forRead', async () => f.runtime);
  Object.assign(f.runtime, {
    attached: true,
    record: { imagesSupported: false },
    submitPrompt: AttachedRuntime.prototype.submitPrompt,
    request: async () => ({ status: 'accepted' }),
  });
  assert.deepEqual(admissionReceipt(await f.bridge.send(args)), {
    status: 'unknown',
    reason: 'INVALID_PROMPT_RESULT',
  });
});
