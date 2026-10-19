import { denyAllPermissions } from './fixtures/permissions.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { makeServer } from '../src/server.mjs';
import { renderContextRead, assertContextReadResponse } from '../src/context-read.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { reserveOwner, updateOwner, releaseOwner } from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';
import { BATCH_RESPONSE_LIMIT } from '../src/batch.mjs';
import { toolResultBytes, TOOL_RESULT_LIMIT } from '../src/response-budget.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';

const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
const text = (value) => ({ type: 'text', text: value });
async function fixture(t, entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-context-mcp-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(path.join(dir, 'agent')),
    principal: 'read-fixture',
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ id: 'project', path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
  };
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge, { folder_id: 'project' }),
    saved = await bridge.session(made.session_id);
  await fs.appendFile(saved.file, entries.map(JSON.stringify).join('\n') + '\n');
  const server = makeServer(bridge),
    client = new Client({ name: 'context-read-fixture', version: '1' });
  const [remote, local] = InMemoryTransport.createLinkedPair();
  await server.connect(local);
  await client.connect(remote);
  const cleanup = [];
  t.after(async () => {
    for (const close of cleanup) await close();
    await client.close();
    await server.close();
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const call = (options) =>
    client.callTool({ name: 'read', arguments: { session_id: made.session_id, ...options } });
  const ok = async (options) => {
    const response = await call(options);
    assert.ok(!response.isError, JSON.stringify(response));
    const result = response.structuredContent;
    assertContextReadResponse(result, { session_id: made.session_id, ...options });
    return result;
  };
  const error = async (options, code) => {
    const result = await call(options);
    assert.equal(result.isError, true);
    assert.equal(JSON.parse(result.content[0].text).error.code, code);
  };
  return {
    dir,
    cwd,
    config,
    bridge,
    client,
    saved,
    id: made.session_id,
    entries,
    cleanup,
    call,
    ok,
    error,
  };
}
function reconstruct(pages) {
  const groups = new Map();
  for (const page of pages)
    for (const item of page.items) {
      const group = groups.get(item.record_index) ?? [];
      group.push(item);
      groups.set(item.record_index, group);
    }
  return [...groups]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => {
      if (group[0].type !== 'fragment') {
        assert.equal(group.length, 1);
        return group[0];
      }
      group.sort((a, b) => a.offset - b.offset);
      let encoded = '';
      for (const part of group) {
        assert.equal(part.offset, encoded.length);
        assert.ok(part.json_fragment.isWellFormed());
        encoded += part.json_fragment;
      }
      assert.equal(encoded.length, group[0].total_units);
      return JSON.parse(encoded);
    });
}
async function pages(f, options = {}, first) {
  let page = first ?? (await f.ok(options)),
    all = [page];
  while (page.next_cursor) {
    page = await f.ok({ ...options, cursor: page.next_cursor });
    all.push(page);
    assert.ok(all.length < 500, 'read makes backward progress');
  }
  return all;
}

test('public MCP reconstructs native system checkpoints, section patches and tool declarations losslessly', async (t) => {
  const section = 'Checkpoint 😀 中文 "\n\\ '.repeat(180);
  const checkpoint = {
    role: 'system',
    content: '',
    sections: { project_context: section, rules: 'native rules', removed: null, empty: '' },
    toolsAdded: [
      {
        name: 'synthetic_tool',
        description: 'TOOL_METADATA '.repeat(1200),
        parameters: { type: 'object' },
      },
    ],
    timestamp: 0,
  };
  const entries = [
    message('kept', null, 'user', 'retained work'),
    {
      type: 'compaction',
      id: 'checkpoint',
      parentId: 'kept',
      summary: 'summary only',
      firstKeptEntryId: 'kept',
      tokensBefore: 20,
      systemMessage: checkpoint,
    },
    message('patch', 'checkpoint', 'system', '', {
      sections: { rules: null, project_context: 'updated' },
      toolsRemoved: [{ name: 'synthetic_tool' }],
    }),
  ];
  const f = await fixture(t, entries),
    before = await fs.readFile(f.saved.file, 'utf8');
  const all = await pages(f, { max_bytes: 4096 }),
    items = reconstruct(all);
  assert.deepEqual(
    items.find((r) => r.type === 'system' && r.source.entry_id === 'checkpoint').message,
    checkpoint,
  );
  assert.deepEqual(items.find((r) => r.source.entry_id === 'patch').message, entries[2].message);
  assert.equal(items.filter((r) => r.type === 'summary').length, 1);
  assert.ok(all.every((p) => Buffer.byteLength(JSON.stringify(p), 'utf8') <= 4096));
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), before);
  assert.equal(f.bridge.pool.instances.size, 0, 'read never cold-starts Pi');
});

test('public MCP applies native edits without flattening system deltas and freezes old continuations', async (t) => {
  const entries = [
    message('u', null, 'user', 'task'),
    message('system', 'u', 'system', '', {
      sections: { rules: 'ORIGINAL_SYSTEM' },
      toolsAdded: [],
    }),
    message('edited', 'system', 'assistant', [text('ORIGINAL_PRIVATE')]),
    message('hidden', 'edited', 'assistant', [text('HIDDEN_PRIVATE')]),
    {
      type: 'context_edit',
      id: 'replace-system',
      parentId: 'hidden',
      targetId: 'system',
      replacement: { content: 'IGNORED_SYSTEM_REPLACEMENT' },
    },
    {
      type: 'context_edit',
      id: 'replace',
      parentId: 'replace-system',
      targetId: 'edited',
      replacement: { content: [text('EFFECTIVE_😀'.repeat(800))] },
    },
    {
      type: 'context_edit',
      id: 'hide',
      parentId: 'replace',
      targetId: 'hidden',
      replacement: null,
    },
  ];
  const f = await fixture(t, entries),
    first = await f.ok({ max_bytes: 4096 });
  assert.ok(first.next_cursor);
  const hideSystem = {
    type: 'context_edit',
    id: 'hide-system',
    parentId: 'hide',
    targetId: 'system',
    replacement: null,
  };
  await fs.appendFile(f.saved.file, JSON.stringify(hideSystem) + '\n');
  const frozen = reconstruct(await pages(f, { max_bytes: 4096 }, first));
  assert.equal(frozen.find((r) => r.type === 'system').message.sections.rules, 'ORIGINAL_SYSTEM');
  assert.equal(frozen.find((r) => r.type === 'text').block.text, 'EFFECTIVE_😀'.repeat(800));
  assert.ok(!JSON.stringify(frozen).includes('PRIVATE'));
  const fresh = reconstruct(await pages(f, { max_bytes: 4096 }));
  assert.ok(!fresh.some((r) => r.type === 'system'));
  const historical = await f.ok({ leaf_id: 'hidden', max_bytes: 65536 });
  assert.ok(JSON.stringify(historical.items).includes('ORIGINAL_PRIVATE'));
  assert.ok(JSON.stringify(historical.items).includes('HIDDEN_PRIVATE'));
});

test('MCP exposes only redesigned read arguments and rejects legacy selectors before inspecting runtime', async (t) => {
  const f = await fixture(t, [message('u', null, 'user', 'task')]);
  const tools = (await f.client.listTools()).tools,
    properties = tools.find((tool) => tool.name === 'read').inputSchema.properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    'cursor',
    'leaf_id',
    'max_bytes',
    'preset',
    'select',
    'session_id',
  ]);
  const reads = t.mock.method(f.bridge, 'read', f.bridge.read.bind(f.bridge));
  for (const obsolete of [
    { view: 'raw' },
    { view: 'overview' },
    { entry_id: 'u' },
    { message_index: 0 },
    { field: 'sections', section: 'rules' },
    { max_chars: 256 },
  ]) {
    const result = await f.call(obsolete);
    assert.equal(result.isError, true, JSON.stringify(obsolete));
  }
  assert.equal(reads.mock.calls.length, 0);
  const batch = await f.client.callTool({
    name: 'batch',
    arguments: {
      operations: [
        { op: 'read', args: { session_id: f.id, view: 'raw' } },
        { op: 'read', args: { session_id: f.id, preset: 'recent' } },
      ],
    },
  });
  assert.ok(!batch.isError);
  assert.equal(batch.structuredContent.results[0].error.code, 'INVALID_OPERATION');
  assert.equal(batch.structuredContent.results[1].result.format, 'context_timeline');
});

test('text selection avoids expanding opaque thinking while preserving late native text and block provenance', async (t) => {
  const opaque = 'OPAQUE_NOT_SELECTED_'.repeat(100000);
  const entries = [
    message('u', null, 'user', [
      text('request'),
      { type: 'image', mimeType: 'image/png', data: 'NATIVE_IMAGE' },
    ]),
    message('a', 'u', 'assistant', [
      { type: 'thinking', thinking: 'private thought', thinkingSignature: opaque },
      text('SHORT_LATER_ANSWER'),
    ]),
  ];
  const f = await fixture(t, entries),
    before = await fs.readFile(f.saved.file, 'utf8');
  const result = await f.ok({ select: { thinking: 0 }, max_bytes: 4096 });
  assert.equal(result.items.at(-1).block.text, 'SHORT_LATER_ANSWER');
  assert.equal(result.items.at(-1).source.block_index, 1);
  assert.equal(result.items[0].message.content[1].data, 'NATIVE_IMAGE');
  assert.ok(!JSON.stringify(result).includes('OPAQUE_NOT_SELECTED'));
  assert.equal(result.omissions.selection.thinking, 1);
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), before);
  assert.equal(f.bridge.pool.instances.size, 0);
});

test('attached owners must implement the new bounded read contract; corrupt replies never fall back to saved history', async (t) => {
  const entries = [
    message('u', null, 'user', 'task'),
    message('a', 'u', 'assistant', [text('answer'.repeat(3000))]),
  ];
  const f = await fixture(t, entries),
    record = await reserveOwner(f.config.attachmentDir, f.saved, 'host');
  let mode = 'legacy',
    tamper;
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      assert.equal(request.generation, record.generation);
      if (request.op === 'state') {
        socket.end(
          JSON.stringify({
            generation: record.generation,
            data: { sessionFile: f.saved.file, sessionId: f.saved.header.id },
          }) + '\n',
        );
        return;
      }
      if (mode === 'error') {
        socket.end(
          JSON.stringify({ generation: record.generation, error: 'RUNTIME_SESSION_CHANGED' }) +
            '\n',
        );
        return;
      }
      const data =
        mode === 'legacy'
          ? { view: 'context', items: [], next_cursor: null }
          : renderContextRead({ header: f.saved.header, entries, leafId: 'a' }, request.body);
      tamper?.(data);
      socket.end(JSON.stringify({ generation: record.generation, data }) + '\n');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(record.socket, resolve);
  });
  await updateOwner(f.config.attachmentDir, f.saved, record, { phase: 'ready' });
  f.cleanup.push(async () => {
    await new Promise((resolve) => server.close(resolve));
    await releaseOwner(f.config.attachmentDir, f.saved, record);
  });
  await f.error({ max_bytes: 4096 }, 'OWNER_READ_REFRESH_REQUIRED');
  mode = 'current';
  const first = await f.ok({ max_bytes: 4096 });
  assert.ok(first.next_cursor);
  for (const mutate of [
    (r) => {
      r.items[0].source = {};
    },
    (r) => {
      r.items[0].record_index = 999;
    },
    (r) => {
      r.session_id = 'other';
    },
    (r) => {
      r.leaf_id = 'other';
    },
    (r) => {
      r.selection.text = 0;
    },
    (r) => {
      r.items = [];
    },
    (r) => {
      r.omissions.capacity.records_before = 999;
    },
    (r) => {
      r.items[0].json_fragment = 'X'.repeat(9000);
    },
  ]) {
    tamper = mutate;
    await f.error({ max_bytes: 4096, leaf_id: 'a' }, 'OWNER_READ_REFRESH_REQUIRED');
  }
  tamper = undefined;
  const next = await f.ok({ max_bytes: 4096, cursor: first.next_cursor });
  assert.equal(next.snapshot, first.snapshot);
  assert.equal(next.live, null);
  mode = 'error';
  await f.error({ max_bytes: 4096 }, 'RUNTIME_SESSION_CHANGED');
  assert.ok([...f.bridge.pool.instances.values()].every((runtime) => runtime.attached));
});

test('cooperative host and saved reads share native history; live updates cannot invalidate committed continuations', async (t) => {
  const entries = [
    message('u', null, 'user', 'request'),
    message('a', 'u', 'assistant', [text('committed 😀'.repeat(1200))]),
    message('system', 'a', 'system', '', { sections: { rules: 'native system' } }),
  ];
  const f = await fixture(t, entries),
    options = { max_bytes: 4096 },
    disk = await f.ok(options);
  const controller = await reserveHostSession({
    attachmentDir: f.config.attachmentDir,
    session: f.saved,
  });
  f.cleanup.push(() => controller.close());
  let liveText = 'live original';
  await controller.ready({
    state: async () => ({
      sessionFile: f.saved.file,
      sessionId: f.saved.header.id,
      isStreaming: true,
    }),
    snapshot: async () => ({
      sessionFile: f.saved.file,
      sessionId: f.saved.header.id,
      entries,
      leafId: 'system',
      live: {
        available: true,
        source: 'host_events',
        observed_at: '2026-01-01T00:00:01Z',
        message: { role: 'assistant', content: [text(liveText)] },
      },
    }),
    submit: async () => {
      throw new Error('READ_MUST_NOT_SUBMIT');
    },
  });
  const active = await f.ok(options);
  assert.deepEqual(active.items, disk.items);
  assert.equal(active.snapshot, disk.snapshot);
  assert.equal(active.live.message.content[0].text, 'live original');
  assert.ok(active.next_cursor);
  liveText = 'live changed 😀'.repeat(3000);
  const continuation = await f.ok({ ...options, cursor: active.next_cursor });
  const savedContinuation = renderContextRead(
    { header: f.saved.header, entries, leafId: 'system' },
    { session_id: f.id, ...options, cursor: active.next_cursor },
  );
  assert.deepEqual(continuation, savedContinuation);
  assert.equal(continuation.live, null);
  f.config.grants.push({ session_id: f.id, read: false });
  const lookups = t.mock.method(f.bridge.pool, 'forRead', () => {
    throw new Error('must not inspect denied runtime');
  });
  await f.error({ ...options, cursor: active.next_cursor }, 'NOT_FOUND_OR_DENIED');
  assert.equal(lookups.mock.calls.length, 0);
});

test('saved, official RPC and native companion share the selected projection without writes or branch navigation', async (t) => {
  const entries = [
    message('a', null, 'user', 'public task'),
    message('b', 'a', 'assistant', [text('public reply')]),
    message('other', null, 'user', 'other branch'),
  ];
  const f = await fixture(t, entries),
    options = { leaf_id: 'b', max_bytes: 65536 };
  const before = await fs.readFile(f.saved.file, 'utf8'),
    disk = await f.ok(options);
  assert.equal(f.bridge.pool.instances.size, 0);
  assert.equal(disk.live, null);
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), before);
  await f.bridge.pool.resolve(await f.bridge.session(f.id));
  // Explicit native startup may persist settings; the read itself must not.
  const afterStartup = await fs.readFile(f.saved.file, 'utf8');
  const rpc = await f.ok(options);
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), afterStartup);
  assert.deepEqual(rpc.items, disk.items);
  assert.equal(rpc.snapshot, disk.snapshot);
  await f.bridge.pool.stop(f.id);
  const original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const manager = SessionManager.open(f.saved.file),
    handlers = {};
  manager.branch('b');
  attachExtension({
    on: (event, fn) => {
      handlers[event] = fn;
    },
  });
  f.cleanup.push(async () => {
    await handlers.session_shutdown?.({ reason: 'quit' });
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  });
  await handlers.session_start(
    {},
    {
      mode: 'tui',
      sessionManager: manager,
      isIdle: () => true,
      hasPendingMessages: () => false,
      shutdown: () => {
        throw new Error('READ_MUST_NOT_SHUTDOWN');
      },
    },
  );
  const attached = await f.ok(options);
  assert.deepEqual(attached.items, disk.items);
  assert.equal(attached.snapshot, disk.snapshot);
  assert.equal(manager.getLeafId(), 'b');
  assert.equal(
    (await f.ok({ max_bytes: 65536 })).leaf_id,
    'b',
    'owner current leaf is not append-tail',
  );
  assert.equal((await f.ok({ leaf_id: 'a' })).items.length, 1);
  assert.equal(manager.getLeafId(), 'b', 'historical read does not navigate owner');
  assert.equal(await fs.readFile(f.saved.file, 'utf8'), afterStartup);
});

test('MCP batch budgets captured read pages and repairs backwards continuation without reacquisition', async (t) => {
  const entries = [
    message('u', null, 'user', 'task'),
    message('a', 'u', 'assistant', [text('😀中文"\\\n'.repeat(9000))]),
  ];
  const f = await fixture(t, entries),
    options = { session_id: f.id, max_bytes: 65536 };
  const reads = t.mock.method(f.bridge, 'read', f.bridge.read.bind(f.bridge));
  const result = await f.client.callTool({
    name: 'batch',
    arguments: { operations: Array.from({ length: 8 }, () => ({ op: 'read', args: options })) },
  });
  assert.ok(!result.isError, JSON.stringify(result));
  const batch = result.structuredContent;
  assert.equal(reads.mock.calls.length, 8, 'rebudget never rereads captured observations');
  assert.ok(Buffer.byteLength(JSON.stringify(batch), 'utf8') <= BATCH_RESPONSE_LIMIT);
  assert.ok(toolResultBytes(batch) <= TOOL_RESULT_LIMIT);
  for (const row of batch.results) {
    assert.ok(row.result, row.error?.code);
    assert.equal(row.result.format, 'context_timeline');
    const first = row.result.items[0];
    assert.equal(first.type, 'fragment');
    const next = await f.ok({ ...options, max_bytes: 4096, cursor: row.result.next_cursor });
    const last = next.items.at(-1);
    assert.equal(last.record_index, first.record_index);
    assert.equal(last.offset + last.json_fragment.length, first.offset);
  }
});
