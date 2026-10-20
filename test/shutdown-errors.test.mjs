import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { executeBatch } from '../src/batch.mjs';

test('late capture storage failure survives runtime removal and close reports it only after cleanup', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-close-error-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = {
    principal: 'fixture',
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [],
    defaults: { ...denyAllPermissions() },
    grants: [],
  };
  await fs.mkdir(config.sessionRoots[0]);
  const bridge = await new Bridge(config).init();
  const failure = Object.assign(new Error('fixture storage failure'), { code: 'ENOSPC' });
  let stopped = false;
  bridge.pool.instances.set('fixture', {
    alive: true,
    recoveryFailures: new Set([failure]),
    async drainRecovery() {},
    async stop() {
      stopped = true;
      this.alive = false;
    },
  });
  await assert.rejects(
    bridge.close(),
    (error) => error.code === 'RECOVERY_PERSIST_FAILED' && error.uncertain === true,
  );
  assert.equal(stopped, true);
  assert.equal(bridge.pool.instances.size, 0);
  await assert.rejects(fs.stat(bridge.lockPath), { code: 'ENOENT' });
  const restarted = await new Bridge(config).init();
  await restarted.close();
});

test('public mutation errors preserve persistence uncertainty and same-request recovery in single and batch replies', async () => {
  const failure = () => Object.assign(new Error('RECEIPT_PERSIST_FAILED'), { uncertain: true });
  const bridge = {
    async send() {
      throw failure();
    },
    async list() {
      return { sessions: [] };
    },
  };
  const args = { session_id: 'known', request_id: 'durable', text: 'fixture' };
  const result = await callBridgeTool(bridge, 'send', args);
  assert.equal(result.isError, true);
  assert.deepEqual(JSON.parse(result.content[0].text).error, {
    code: 'RECEIPT_PERSIST_FAILED',
    uncertain: true,
    recovery: 'SAME_REQUEST_ID',
    request_id: 'durable',
  });
  const batch = await executeBatch(bridge, {
    operations: [
      { op: 'send', args },
      { op: 'list', args: {} },
    ],
  });
  assert.equal(batch.results[0].error.uncertain, true);
  assert.equal(batch.results[0].error.request_id, 'durable');
  assert.deepEqual(batch.results[1].result, { sessions: [] });
});

test('a huge malformed operation name cannot consume the batch response or hide later outcomes', async () => {
  let calls = 0;
  const result = await executeBatch(
    {
      async list() {
        calls++;
        return { sessions: [] };
      },
    },
    {
      operations: [
        { op: 'x'.repeat(1000000), args: {} },
        { op: 'list', args: {} },
      ],
    },
  );
  assert.equal(calls, 1);
  assert.equal(result.results[0].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[0].error.op_truncated, true);
  assert.deepEqual(result.results[1].result, { sessions: [] });
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
});
