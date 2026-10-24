import { Bridge } from '../src/bridge.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch, preflightBatch } from '../src/batch.mjs';
import { toolDefinitions, dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';
import { makeServer } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const mockBridge = (methods) => ({
  inputs: new Set(),
  locks: new Map(),
  registerInput: Bridge.prototype.registerInput,
  ...methods,
});
const send = (session_id, text) => ({
  op: 'send',
  args: { session_id, text },
});
test('batch is a transparent wrapper with per-item validation and original-order results', async () => {
  const calls = [],
    bridge = mockBridge({
      send: async (args) => {
        calls.push(args.text);
        return { status: 'accepted' };
      },
      read: async () => {
        throw new Error('NOT_FOUND_OR_DENIED');
      },
      health: async () => ({ ok: true }),
    });
  const result = await executeBatch(bridge, {
    operations: [
      send('a', 'one'),
      { op: 'read', args: { session_id: 'denied' } },
      null,
      { op: 'batch', args: {} },
      { op: 'health', args: {} },
      send('a', 'two'),
    ],
  });
  assert.deepEqual(calls, ['one', 'two']);
  assert.deepEqual(
    result.results.map((x) => x.index),
    [0, 1, 2, 3, 4, 5],
  );
  assert.equal(result.results[1].error.code, 'NOT_FOUND_OR_DENIED');
  assert.equal(result.results[2].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[3].error.code, 'INVALID_OPERATION');
  assert.equal(result.results[4].result.ok, true);
});
test('MCP discovery describes batch items and both protocol paths retain per-item validation', async (t) => {
  const bridge = mockBridge({ health: async () => ({ ok: true }) }),
    server = makeServer(bridge),
    client = new Client({ name: 'batch-schema-test', version: '1' }),
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => {
    await client.close();
    await server.close();
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools,
    batch = tools.find((tool) => tool.name === 'batch').inputSchema,
    items = batch.properties.operations.items;
  assert.deepEqual(batch, toolDefinitions().find((tool) => tool.name === 'batch').inputSchema);
  assert.equal(items.type, 'object');
  assert.deepEqual(items.required, ['op', 'args']);
  assert.equal(items.additionalProperties, false);
  assert.equal(items.properties.args.type, 'object');
  assert.deepEqual(
    items.properties.op.enum.slice().sort(),
    tools
      .filter((tool) => tool.name !== 'batch')
      .map((tool) => tool.name)
      .sort(),
  );
  const args = {
    operations: [
      null,
      { op: 'batch', args: {} },
      { op: 'constructor', args: {} },
      { op: 'health', args: {}, extra: true },
      { op: 'send', args: { session_id: 'a', text: '' } },
      { op: 'set_model', args: { session_id: 'a' } },
      { op: 'command', args: { session_id: 'a', command: 'true', unexpected: true } },
      { op: 'health', args: {} },
    ],
  };
  const modern = await dispatchModern(bridge, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'batch',
      arguments: args,
      _meta: { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} },
    },
  });
  for (const result of [
    modern.message.result,
    await client.callTool({ name: 'batch', arguments: args }),
  ]) {
    assert.ok(!result.isError, JSON.stringify(result));
    const { status, results } = result.structuredContent;
    assert.equal(status, 'processed');
    assert.ok(results.slice(0, -1).every((item) => item.error.code === 'INVALID_OPERATION'));
    assert.deepEqual(results.at(-1).result, { ok: true });
  }
});

test('different sessions progress independently while each session retains input order', async () => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers(),
    events = [];
  const bridge = mockBridge({
    send: async (args) => {
      events.push(args.text);
      if (args.text === 'a1') {
        entered.resolve();
        await release.promise;
      }
      return { status: 'accepted' };
    },
  });
  const pending = executeBatch(bridge, {
    operations: [send('a', 'a1'), send('a', 'a2'), send('b', 'b1')],
  });
  await entered.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['a1', 'b1']);
  release.resolve();
  await pending;
  assert.deepEqual(events, ['a1', 'b1', 'a2']);
});
test('outer size/shape bounds reject before any operation but bad item args do not', async () => {
  let calls = 0;
  const bridge = mockBridge({
    send: async () => {
      calls++;
      return { status: 'accepted' };
    },
  });
  for (const input of [
    { operations: [] },
    { operations: Array.from({ length: 11 }, () => send('a', 'x')) },
    { operations: [send('a', 'x')], extra: true },
  ]) {
    assert.equal((await executeBatch(bridge, input)).status, 'rejected');
    assert.equal(calls, 0);
  }
  const result = await executeBatch(bridge, {
    operations: [
      { op: 'send', args: { session_id: 'a', text: '', mode: 'invented' } },
      send('a', 'good'),
    ],
  });
  assert.equal(result.results[0].error.code, 'INVALID_OPERATION');
  assert.equal(calls, 1);
  assert.ok(preflightBatch({ operations: [null] }).operations);
});
test('fork shares its source lane; list and health do not add mutation permissions', async () => {
  const events = [],
    bridge = mockBridge({
      send: async () => {
        events.push('send');
      },
      create: async () => {
        events.push('fork');
        return { session_id: 'child' };
      },
      list: async () => ({ sessions: [] }),
      health: async () => ({ ok: true }),
    });
  const result = await executeBatch(bridge, {
    operations: [
      send('parent', 's'),
      {
        op: 'create',
        args: { project: '/project', fork_from: 'parent', text: 'first' },
      },
      { op: 'list', args: {} },
      { op: 'health', args: { domain: 'runtime' } },
    ],
  });
  assert.deepEqual(events, ['send', 'fork']);
  assert.equal(result.results.length, 4);
});
