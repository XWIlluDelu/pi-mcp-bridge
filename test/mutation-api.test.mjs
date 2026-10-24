import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { executeBatch } from '../src/batch.mjs';
import { limitBashResult } from '../src/bash-execution.mjs';
import { withdrawalCollector } from '../src/stop-execution.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { MCP_RESPONSE_LIMIT, toolResultBytes, TOOL_RESULT_LIMIT } from '../src/response-budget.mjs';

function admissionReceipt(result, ids) {
  const { submission_id, ...receipt } = result;
  assert.match(
    submission_id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  if (ids) {
    assert.equal(ids.has(submission_id), false, 'Every independent input has a distinct ID');
    ids.add(submission_id);
  }
  return receipt;
}

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-mutation-api-'));
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  const config = {
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: project }],
    defaults: Object.fromEntries(Object.keys(denyAllPermissions()).map((key) => [key, true])),
    piRuntime: { agentDir: path.join(dir, 'agent'), inheritEnv: [] },
  };
  const calls = { prompt: 0, command: 0, stop: 0 };
  let session, bridge;
  const runtime = {
    alive: true,
    generation: 'fixture-generation',
    state: async () => ({ isStreaming: false }),
    command: async () => {
      calls.prompt++;
      return { disposition: 'started' };
    },
    selectModel: async (model, options) => ({
      model: model ?? { provider: 'fixture', id: 'native' },
      thinking_level: options.thinkingLevel ?? 'off',
    }),
    executeBash: async ({ max_chars }) => {
      calls.command++;
      return limitBashResult(
        {
          output: 'Unicode 😀 "\\ newline\n'.repeat(100),
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
        max_chars,
      );
    },
    stopExecution: async ({ max_chars }) => {
      calls.stop++;
      const withdrawn = withdrawalCollector(max_chars);
      return {
        status: 'accepted',
        acknowledgement: 'native_ack',
        coverage: 'agent_and_bash',
        withdrawal: withdrawn.add({ text: 'withdrawn 😀 '.repeat(100), includesEditorDraft: true }),
      };
    },
    stop: async () => {
      runtime.alive = false;
    },
  };
  bridge = await new Bridge(config, async () => runtime).init();
  const made = await savedSession(bridge);
  session = await bridge.session(made.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { bridge, runtime, calls, project, id: made.session_id, config };
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
  assert.deepEqual(f.calls, { prompt: 0, command: 0, stop: 0 });
});

test('invalid list filters and missing mutation payloads do not dispatch', async (t) => {
  const f = await fixture(t);
  for (const args of [{ limit: 0 }, { offset: -1 }, { active_after: 'not-a-date' }, { project: 1 }])
    await assert.rejects(f.bridge.list(args), /INVALID_ARGUMENTS/);
  await assert.rejects(f.bridge.send({ session_id: f.id }), /INVALID_ARGUMENTS/);
  assert.deepEqual(f.calls, { prompt: 0, command: 0, stop: 0 });
});

test('identical direct, MCP and batch calls are independent submissions with minimal results', async (t) => {
  const f = await fixture(t),
    args = { session_id: f.id, text: 'same' },
    ids = new Set();
  assert.deepEqual(admissionReceipt(await f.bridge.send(args), ids), { status: 'started' });
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      admissionReceipt(
        (await callBridgeTool(f.bridge, 'send', args, { requestId: 'same-attempt' }))
          .structuredContent,
        ids,
      ),
      { status: 'started' },
    );
  const batch = {
    operations: [
      { op: 'send', args },
      { op: 'send', args },
    ],
  };
  for (let i = 0; i < 2; i++) {
    const result = await executeBatch(f.bridge, batch);
    for (const item of result.results)
      assert.deepEqual(admissionReceipt(item.result, ids), { status: 'started' });
  }
  assert.equal(f.calls.prompt, 7);
  assert.equal(ids.size, 7);
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
  f.runtime.attached = true;
  f.runtime.send = async () => ({ status: 'accepted' });
  assert.deepEqual(admissionReceipt(await f.bridge.send(args)), {
    status: 'unknown',
    reason: 'INVALID_PROMPT_RESULT',
  });
});

test('command and stop return bounded prefixes without handles or continuation and each call acts again', async (t) => {
  const f = await fixture(t);
  await f.bridge.send({ session_id: f.id, text: 'open' });
  for (const op of ['command', 'stop']) {
    const args = {
      session_id: f.id,
      max_chars: 256,
      ...(op === 'command' ? { command: 'fixture' } : {}),
    };
    for (let i = 0; i < 2; i++) {
      const result = await f.bridge[op](args);
      assert.equal(result.status, 'accepted');
      assert.equal(result[op === 'command' ? 'response_complete' : 'withdrawn_complete'], false);
    }
    assert.equal(f.calls[op], 2);
  }
});

test('batch retains child IDs, restore tokens and maximum-size actual model selections', async (t) => {
  const f = await fixture(t),
    model = { provider: '\0'.repeat(256), id: '\0'.repeat(256) },
    removed = await savedSession(f.bridge);
  f.config.piArgs = ['--session-dir', f.config.sessionRoots[0]];
  const operations = Array.from({ length: 4 }, () => [
    { op: 'create', args: { project: f.project, text: 'initial', model, thinking_level: 'high' } },
    { op: 'set_model', args: { session_id: f.id, model, thinking_level: 'high' } },
  ]).flat();
  operations.push(
    { op: 'delete', args: { session_id: removed.session_id } },
    { op: 'send', args: { session_id: f.id, text: 'next', model, thinking_level: 'high' } },
  );
  const response = await callBridgeTool(f.bridge, 'batch', { operations });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(
    Buffer.byteLength(
      JSON.stringify({ jsonrpc: '2.0', id: '\0'.repeat(1024), result: response }),
    ) <= MCP_RESPONSE_LIMIT,
  );
  const batch = response.structuredContent;
  assert.ok(toolResultBytes(batch) <= TOOL_RESULT_LIMIT);
  for (let i = 0; i < 8; i += 2) {
    const created = batch.results[i].result,
      selected = batch.results[i + 1].result;
    assert.equal(created.status, 'started', JSON.stringify(created));
    assert.equal(created.created, true);
    assert.match(created.session_id, /^ps_[0-9a-f]{32}$/);
    assert.deepEqual(created.send.model_selection, { model, thinking_level: 'high' });
    assert.deepEqual(selected, { model, thinking_level: 'high' });
  }
  assert.equal(
    new Set(
      batch.results.filter(({ op }) => op === 'create').map(({ result }) => result.session_id),
    ).size,
    4,
  );
  assert.equal(batch.results[8].result.status, 'deleted');
  assert.match(batch.results[8].result.restore_token, /^[0-9a-f-]{36}$/);
  assert.deepEqual(batch.results[9].result.model_selection, { model, thinking_level: 'high' });
  assert.equal(f.calls.prompt, 5);
});
