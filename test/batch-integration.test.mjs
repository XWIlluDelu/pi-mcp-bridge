import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const item = (op, args) => ({ op, args });
const completedAnswers = (read) => read.items.filter((record) => record.type === 'text').length;

test('mixed public MCP batches preserve history across reconnect and isolate item failures and permissions', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-batch-rpc-'));
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
    piArgs: [
      ...isolatedRuntime(dir).piArgs,
      '-e',
      path.join(base, 'test/fixtures/faux-extension.mjs'),
      '--provider',
      'bridge-fixture',
      '--model',
      'deterministic',
    ],
  };
  const filename = path.join(dir, 'config.json');
  await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  let client;
  t.after(async () => {
    await client?.close();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  async function connect() {
    client = new Client({ name: 'mixed-batch-fixture', version: '1.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(base, 'src/server.mjs'), filename],
        cwd: base,
        env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: '1' },
        stderr: 'pipe',
      }),
    );
  }
  async function call(name, args) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  }
  async function waitForAnswers(session_id, expected) {
    const deadline = Date.now() + 10000;
    let read;
    do {
      read = await call('read', { session_id, preset: 'full' });
      if (completedAnswers(read) >= expected) return read;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail('Native synthetic answers did not settle: ' + JSON.stringify(read));
  }

  await connect();
  const seeds = [];
  for (const label of ['A', 'B']) {
    const made = await call('create', {
      project: cwd,

      text: 'Seed ' + label,
    });
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    seeds.push(made.session_id);
  }
  const [a, b] = seeds;
  await Promise.all([waitForAnswers(a, 1), waitForAnswers(b, 1)]);

  // A malformed item must not block its valid neighbor or introduce whole-batch
  // conflict rules. Deletion and a later send use their ordinary session lane.
  const invalid = await call('batch', {
    operations: [
      item('create', { project: cwd, text: 'Temporary fixture' }),
      item('read', { session_id: a, max_bytes: 1 }),
    ],
  });
  assert.equal(invalid.status, 'processed');
  assert.equal(invalid.results[0].result.status, 'started');
  assert.equal(invalid.results[1].error.code, 'INVALID_OPERATION');
  const temporary = invalid.results[0].result.session_id;
  const ordered = await call('batch', {
    operations: [
      item('delete', { session_id: temporary }),
      item('send', { session_id: temporary, text: 'Never dispatch' }),
      item('read', { session_id: a }),
    ],
  });
  assert.equal(ordered.status, 'processed');
  assert.equal(ordered.results[0].result.status, 'deleted');
  assert.equal(ordered.results[1].result.status, 'rejected');
  assert.equal(ordered.results[1].result.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(ordered.results[2].result.session_id, a);

  const operations = [
    item('send', { session_id: a, text: 'PUBLIC_BATCH_FIXTURE' }),
    item('read', { session_id: a, preset: 'recent', max_bytes: 12000 }),
    item('create', { project: cwd, text: 'Created inside batch' }),
    item('delete', { session_id: b }),
    item('read', { session_id: 'missing' }),
    item('create', {
      project: path.join(dir, 'denied'),

      text: 'Must refuse',
    }),
    item('health', {}),
    item('command', { session_id: a, command: 'echo never-execute' }),
    item('stop', { session_id: a }),
  ];
  const first = await call('batch', { operations });
  assert.equal(first.status, 'processed');
  assert.deepEqual(
    first.results.map((result) => result.index),
    operations.map((_, index) => index),
  );
  assert.equal(first.results[0].result.status, 'started');
  assert.ok(['started', 'queued'].includes(first.results[0].result.status));
  assert.equal(first.results[1].result.session_id, a);
  assert.ok(Buffer.byteLength(JSON.stringify(first.results[1].result)) <= 12000);
  assert.equal(first.results[2].result.status, 'started');
  assert.equal(first.results[2].result.created, true);
  assert.equal(first.results[3].result.status, 'deleted');
  assert.equal(first.results[4].error.code, 'NOT_FOUND_OR_DENIED');
  assert.equal(first.results[5].result.status, 'rejected');
  assert.equal(first.results[6].result.domain, 'permissions');
  assert.equal(first.results[7].error.code, 'NOT_FOUND_OR_DENIED');
  assert.equal(first.results[8].error.code, 'NOT_FOUND_OR_DENIED');
  const c = first.results[2].result.session_id;
  await Promise.all([waitForAnswers(a, 2), waitForAnswers(c, 1)]);

  await client.close();
  await connect();
  const read = await call('read', { session_id: a, preset: 'full' });
  assert.equal(completedAnswers(read), 2);
  assert.equal(JSON.stringify(read.items).split('PUBLIC_BATCH_FIXTURE').length - 1, 1);
  assert.equal((await call('list', {})).sessions.length, 2);
  const multiple = await call('batch', {
    operations: [
      item('read', { session_id: a, preset: 'recent' }),
      item('read', { session_id: c, select: { thinking: 0, tools: 0 } }),
    ],
  });
  assert.ok(multiple.results.every((result) => Array.isArray(result.result.items)));
  assert.ok(JSON.stringify(multiple.results[1].result.items).includes('Created inside batch'));

  config.grants.push({ session_id: a, read: false, send: true, delete: false });
  await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  const independent = await call('batch', {
    operations: [
      item('read', { session_id: a }),
      item('send', { session_id: a, text: 'NO_RECEIPT_CONTENT' }),
      item('read', { session_id: c }),
    ],
  });
  assert.equal(independent.results[0].error.code, 'NOT_FOUND_OR_DENIED');
  assert.equal(independent.results[1].result.status, 'started');
  assert.ok(!JSON.stringify(independent.results[1]).includes('NO_RECEIPT_CONTENT'));
  assert.ok(!JSON.stringify(independent.results[1]).includes(cwd));
  assert.ok(JSON.stringify(independent.results[2].result.items).includes('Created inside batch'));
  const removal = await call('batch', {
    operations: [item('delete', { session_id: a }), item('delete', { session_id: c })],
  });
  assert.equal(removal.results[0].result.status, 'rejected');
  assert.equal(removal.results[1].result.status, 'deleted');
});
