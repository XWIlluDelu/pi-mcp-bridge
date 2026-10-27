import { READ_CONTRACT, assertReadSnapshot } from '../src/context-read.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { test } from 'node:test';
import packageInfo from '../package.json' with { type: 'json' };
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { SessionManager } from './fixtures/pi.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../src/bridge.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import { readSource } from './fixtures/read-source.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { makeServer } from '../src/server.mjs';
import { assertContextReadResponse, chronological } from './fixtures/read-pages.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { reserveOwner, updateOwner } from '../src/attachments.mjs';
import attachExtension from './fixtures/companion.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { MCP_RESPONSE_LIMIT, TOOL_RESULT_LIMIT, toolResultBytes } from '../src/response-budget.mjs';
import { dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';

const message = (id, parentId, role, content, extra = {}) => ({
  type: 'message',
  id,
  parentId,
  timestamp: '2026-01-01T00:00:00Z',
  message: { role, content, timestamp: 0, ...extra },
});
const text = (value) => ({ type: 'text', text: value });
async function fixture(t, entries, overrides = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-context-mcp-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(path.join(dir, 'agent')),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    attachmentDir: path.join(dir, 'ipc'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
    ...overrides,
  };
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge),
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
  // Browse through the public contract; explicitly expand refs when checking source units.
  const call = (options) =>
    client.callTool({
      name: 'read',
      arguments: { session_id: made.session_id, ...options },
    });
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
    source: (options = {}) => readSource(ok, options),
    error,
  };
}

async function follow(f, cursor, extra = {}) {
  const response = await f.client.callTool({
    name: 'read',
    arguments: { cursor, max_bytes: 4096, ...extra },
  });
  assert.ok(!response.isError, JSON.stringify(response));
  assertContextReadResponse(response.structuredContent, { max_bytes: extra.max_bytes ?? 4096 });
  return response.structuredContent;
}
async function allPages(f, first) {
  const result = [first];
  while (result.at(-1).next_cursor) {
    result.push(await follow(f, result.at(-1).next_cursor));
    assert.ok(result.length < 200);
  }
  return result;
}
const paragraphs = (n = 80) =>
  Array.from({ length: n }, (_, i) => 'Paragraph-' + i + ' 漢😀"\\ '.repeat(20) + '\n\n').join('');

test('public MCP reads task text plus honest image descriptors, without signatures or internal payload metadata', async (t) => {
  const f = await fixture(t, [
    message('system', null, 'system', '', { sections: { rules: paragraphs() } }),
    message('u', 'system', 'user', [
      text('IMPORTANT TASK'),
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50000) },
    ]),
    message(
      'a',
      'u',
      'assistant',
      [{ type: 'text', text: 'answer', textSignature: 'NATIVE_SECRET' }],
      { responseId: 'NATIVE_SECRET', usage: { cost: 20 }, stopReason: 'stop', model: 'native' },
    ),
  ]);
  const response = await dispatchModern(f.bridge, {
    jsonrpc: '2.0',
    id: '\0'.repeat(1024),
    method: 'tools/call',
    params: {
      name: 'read',
      arguments: { session_id: f.id, max_bytes: 4096 },
      _meta: {
        [META + 'protocolVersion']: MODERN_VERSION,
        [META + 'clientCapabilities']: {},
      },
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(response.message)) <= MCP_RESPONSE_LIMIT);
  const page = response.message.result.structuredContent;
  assertContextReadResponse(page, { max_bytes: 4096 });
  assert.equal(
    page.next_cursor,
    null,
    'large system context must not displace the task and answer',
  );
  assert.equal(page.omissions.selection.system, 1);
  assert.ok(JSON.stringify(page).includes('IMPORTANT TASK'));
  assert.ok(!JSON.stringify(page).includes('AAAAAAA'));
  assert.ok(!JSON.stringify(page).includes('NATIVE_SECRET'));
  const source = await readSource(f.ok, { max_bytes: 4096 });
  assert.deepEqual(source.items[0].message.content[1], {
    type: 'image',
    mime_type: 'image/png',
    data_omitted: true,
  });
  assert.equal(source.items[1].metadata.stopReason, 'stop');
});

test('cursor-only direct/MCP/batch continuation inherits custom selection and frozen content after append', async (t) => {
  const value = paragraphs(),
    f = await fixture(t, [
      message('u', null, 'user', 'task'),
      message('a', 'u', 'assistant', [text(value)]),
    ]);
  const browse = await f.ok({
    max_bytes: 4096,
    range: { recent: -1 },
    content: { ...ALL_CONTENT, thinking: 0, tool: 0, command: 0 },
  });
  const first = await f.ok({
    refs: [browse.items.find((item) => item.type === 'assistant').ref],
    max_bytes: 4096,
  });
  assert.ok(first.next_cursor);
  await fs.appendFile(
    f.saved.file,
    JSON.stringify(message('later', 'a', 'user', 'LATER_MUTATION')) + '\n',
  );
  const direct = await f.bridge.read({
    cursor: first.next_cursor,
    max_bytes: 8192,
    content: { tool: 0 },
  });
  assert.equal(direct.leaf_id, 'a');
  const batch = await f.client.callTool({
    name: 'batch',
    arguments: { operations: [{ op: 'read', args: { cursor: first.next_cursor } }] },
  });
  assert.deepEqual(batch.structuredContent.results[0].result.selection, first.selection);
  for (const extra of [
    { range: { recent: 1 } },
    { content: { assistant: 0 } },
    { content: { system: false } },
    { leaf_id: null },
  ])
    await f.error({ cursor: first.next_cursor, ...extra }, 'STALE_CURSOR');
  const pages = await allPages(f, first),
    units = chronological(pages);
  assert.equal(
    units
      .filter((unit) => unit.type === 'text')
      .map((unit) => unit.block.text)
      .join(''),
    value,
  );
  assert.ok(!JSON.stringify(pages).includes('LATER_MUTATION'));
  assert.equal((await f.ok()).leaf_id, 'later');
});

test('owned RPC exit and controller changes cannot invalidate frozen history or bypass fresh read grants', async (t) => {
  const f = await fixture(t, [
    message('u', null, 'user', 'task'),
    message('a', 'u', 'assistant', [text(paragraphs())]),
  ]);
  const rpc = await f.bridge.pool.resolve(f.saved);
  const browse = await f.ok({ max_bytes: 4096 });
  const first = await f.ok({
    refs: [browse.items.find((item) => item.type === 'assistant').ref],
    max_bytes: 4096,
  });
  assert.equal(first.source, 'rpc');
  await f.bridge.pool.stop(f.id);
  assert.equal(rpc.alive, false);
  t.mock.method(f.bridge.pool, 'forRead', () =>
    assert.fail('Frozen continuation must not route to a new owner'),
  );
  const next = await follow(f, first.next_cursor);
  assert.equal(next.leaf_id, first.leaf_id);
  f.config.grants.push({ folder: f.cwd, read: false });
  const denied = await f.client.callTool({
    name: 'read',
    arguments: { cursor: first.next_cursor },
  });
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'NOT_FOUND_OR_DENIED');
});

test('new companion and host send selected sanitized snapshots on op:read; raw snapshots remain for fork', async (t) => {
  const entries = [
    message('system', null, 'system', 'READ_RULES', {
      toolsAdded: [
        {
          name: 'declared',
          description: 'DECLARATION '.repeat(300),
          parameters: { type: 'object' },
        },
      ],
    }),
    message('u', 'system', 'user', [
      text('task'),
      { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50000) },
    ]),
    message('a', 'u', 'assistant', [text(paragraphs())]),
  ];
  for (const kind of ['host', 'companion']) {
    const f = await fixture(t, entries),
      cleanDisk = await f.source({ max_bytes: 65536 });
    if (kind === 'host') {
      const owner = await reserveHostSession({
        buildSessionProjection: hostProjection,
        attachmentDir: f.config.attachmentDir,
        session: f.saved,
      });
      f.cleanup.push(() => owner.close());
      await owner.ready({
        state: () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id }),
        snapshot: () => ({
          sessionFile: f.saved.file,
          sessionId: f.saved.header.id,
          entries,
          leafId: 'a',
        }),
        submit: async () => ({ status: 'accepted', disposition: 'handled' }),
      });
    } else {
      const previous = process.env.PI_MCP_ATTACH_DIR,
        handlers = {},
        manager = SessionManager.open(f.saved.file);
      process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
      await attachExtension({
        getThinkingLevel: () => 'off',
        on: (event, fn) => {
          handlers[event] = fn;
        },
      });
      f.cleanup.push(async () => {
        await handlers.session_shutdown?.({ reason: 'quit' });
        if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
        else process.env.PI_MCP_ATTACH_DIR = previous;
      });
      await handlers.session_start(
        {},
        {
          mode: 'tui',
          sessionManager: manager,
          isIdle: () => true,
          hasPendingMessages: () => false,
          shutdown: () => assert.fail('Read must not shut down owner'),
        },
      );
    }
    const active = await f.source({ max_bytes: 65536 });
    assert.deepEqual(active.items, cleanDisk.items);
    const runtime = await f.bridge.pool.forRead(f.saved),
      captured = await runtime.read({ session_id: f.id });
    assert.equal(captured.contract, READ_CONTRACT);
    assert.ok(Array.isArray(captured.units));
    assert.ok(!JSON.stringify(captured).includes('AAAAAAA'));
    assert.ok(!captured.units.some((unit) => unit.message?.toolsAdded));
    assert.equal(captured.omissions.system, 1);
    assert.ok(!captured.units.some((unit) => unit.type === 'system'));
    const full = await runtime.read({
      session_id: f.id,
      range: { recent: -1 },
      content: ALL_CONTENT,
    });
    assert.ok(full.units.some((unit) => unit.message?.content === 'READ_RULES'));
    assert.ok(full.units.some((unit) => unit.message?.toolsAdded?.[0].name === 'declared'));
    const raw = await runtime.snapshot();
    assert.ok(JSON.stringify(raw).includes('AAAAAAA'));
    assert.deepEqual(
      raw.entries.find((entry) => entry.id === 'system').message,
      entries[0].message,
    );
    assert.equal(raw.leafId, 'a');
  }
});

test('optional input mappings agree across saved, owned RPC, companion and host reads with frozen paging and raw fork data', async (t) => {
  const module = fileURLToPath(new URL('../integrations/intercom/index.mjs', import.meta.url));
  for (const kind of ['saved', 'rpc', 'companion', 'host']) {
    await t.test(kind, async (t) => {
      const details = {
        from: { id: 'sender', cwd: '/project' },
        message: {
          id: 'delivery',
          content: {
            text: 'INPUT_2',
            attachments: [{ type: 'snippet', name: 'note', content: 'ATTACHMENT' }],
          },
        },
        bodyText: 'INPUT_2',
        replyCommand: 'intercom reply',
      };
      const entries = [
        message('human', null, 'user', 'HUMAN_INPUT'),
        {
          type: 'custom_message',
          id: 'i1',
          parentId: 'human',
          customType: 'intercom_message',
          content: 'INPUT_1',
          display: true,
          timestamp: '2026-01-01T00:00:00Z',
        },
        message('a1', 'i1', 'assistant', [text('PRIOR_ANSWER')]),
        {
          type: 'custom_message',
          id: 'i2',
          parentId: 'a1',
          customType: 'intercom_message',
          content: '**From Sender**\n\nINPUT_2',
          details,
          display: true,
          timestamp: '2026-01-01T00:00:00Z',
        },
        message('a2', 'i2', 'assistant', [text(paragraphs(40))]),
      ];
      const f = await fixture(t, entries, { compatibilityModules: [{ module }] });
      if (kind === 'rpc') await f.bridge.pool.resolve(f.saved);
      else if (kind === 'host') {
        const owner = await reserveHostSession({
          buildSessionProjection: hostProjection,
          attachmentDir: f.config.attachmentDir,
          session: f.saved,
        });
        f.cleanup.push(() => owner.close());
        await owner.ready({
          state: () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id }),
          snapshot: () => ({
            sessionFile: f.saved.file,
            sessionId: f.saved.header.id,
            entries,
            leafId: 'a2',
          }),
          submit: () => assert.fail('Read must not submit input'),
        });
      } else if (kind === 'companion') {
        const previous = process.env.PI_MCP_ATTACH_DIR,
          handlers = {};
        process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
        await attachExtension({
          getThinkingLevel: () => 'off',
          on: (event, fn) => {
            handlers[event] = fn;
          },
        });
        f.cleanup.push(async () => {
          await handlers.session_shutdown?.({ reason: 'quit' });
          if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
          else process.env.PI_MCP_ATTACH_DIR = previous;
        });
        await handlers.session_start(
          {},
          {
            mode: 'tui',
            sessionManager: SessionManager.open(f.saved.file),
            isIdle: () => true,
            hasPendingMessages: () => false,
            shutdown: () => assert.fail('Read must not shut down owner'),
          },
        );
      }
      const fileBefore = await fs.readFile(f.saved.file);
      const found = await f.client.callTool({
        name: 'search',
        arguments: {
          session_id: f.id,
          view: 'session',
          query: 'PRIOR_ANSWER',
          content: ['assistant'],
        },
      });
      assert.ok(!found.isError, JSON.stringify(found));
      assert.equal(found.structuredContent.matches, 1);
      assert.equal(found.structuredContent.items[0].source.entry_id, 'a1');
      const expanded = await f.client.callTool({
        name: 'read',
        arguments: {
          refs: [found.structuredContent.items[0].ref],
        },
      });
      assert.ok(!expanded.isError, JSON.stringify(expanded));
      assert.equal(expanded.structuredContent.items[0].block.text, 'PRIOR_ANSWER');
      const browse = await f.ok({ range: { recent: 1 }, max_bytes: 4096 });
      const first = await f.ok({ refs: browse.items.map((item) => item.ref), max_bytes: 4096 });
      assert.equal(first.source, kind === 'companion' ? 'tui' : kind);
      const units = chronological(await allPages(f, first));
      assert.ok(units.every((unit) => ['i2', 'a2'].includes(unit.source.entry_id)));
      const input = units.find((unit) => unit.type === 'prompt');
      assert.equal(input.source.read_adapter, 'pi-intercom');
      assert.equal(input.message.role, 'custom');
      assert.deepEqual(input.message.details, details);
      assert.ok(units.filter((u) => u.type === 'text').every((u) => u.prompt_id === 'i2'));
      assert.equal(
        units
          .filter((u) => u.type === 'text')
          .map((u) => u.block.text)
          .join(''),
        paragraphs(40),
      );
      const native = await loadSavedSession(f.saved);
      assert.deepEqual(native.entries.find((e) => e.id === 'i2').details, details);
      if (kind !== 'saved' && kind !== 'rpc') {
        const raw = await (await f.bridge.pool.forRead(f.saved)).snapshot();
        assert.deepEqual(
          raw.entries.find((e) => e.id === 'i2'),
          entries[3],
        );
      }
      assert.deepEqual(
        await fs.readFile(f.saved.file),
        fileBefore,
        'Read must not rewrite native history',
      );
    });
  }
});

test('disabled compatibility module leaves native custom reading intact', async (t) => {
  const module = fileURLToPath(new URL('../integrations/intercom/index.mjs', import.meta.url));
  const f = await fixture(
    t,
    [
      message('u', null, 'user', 'HUMAN_INPUT'),
      {
        type: 'custom_message',
        id: 'i',
        parentId: 'u',
        customType: 'intercom_message',
        content: 'PLUGIN_INPUT',
        display: true,
      },
      message('a', 'i', 'assistant', [text('answer')]),
    ],
    { compatibilityModules: [{ module, enabled: false }] },
  );
  const result = await f.source();
  const input = result.items.find((item) => item.source.entry_id === 'i');
  assert.equal(input.type, 'custom');
  assert.equal(input.prompt_id, 'u');
  assert.equal(input.source.read_adapter, undefined);
  assert.equal(result.items.find((item) => item.type === 'text').prompt_id, 'u');
});

test('batch budgets the first render of captured snapshots and preserves cursor continuity after a later mutation', async (t) => {
  const value = paragraphs(160),
    entries = [message('u', null, 'user', 'task'), message('a', 'u', 'assistant', [text(value)])],
    f = await fixture(t, entries),
    owner = await reserveHostSession({
      buildSessionProjection: hostProjection,
      attachmentDir: f.config.attachmentDir,
      session: f.saved,
    });
  f.cleanup.push(() => owner.close());
  let snapshots = 0,
    submissions = 0,
    leafId = 'a';
  await owner.ready({
    state: () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id }),
    snapshot: () => {
      snapshots++;
      return { sessionFile: f.saved.file, sessionId: f.saved.header.id, entries, leafId };
    },
    submit: async () => {
      submissions++;
      const next = message('later', 'a', 'user', 'LATER_MUTATION');
      entries.push(next);
      leafId = 'later';
      await fs.appendFile(f.saved.file, JSON.stringify(next) + '\n');
      return { status: 'accepted', disposition: 'handled' };
    },
  });
  const captures = [];
  for (let i = 0; i < 8; i++) captures.push(await f.ok({ max_bytes: 4096 }));
  const response = await f.client.callTool({
    name: 'batch',
    arguments: {
      operations: [
        ...captures.map((capture) => ({
          op: 'read',
          args: {
            refs: [capture.items.find((item) => item.type === 'assistant').ref],
            max_bytes: 65536,
          },
        })),
        { op: 'send', args: { session_id: f.id, text: 'LATER_MUTATION' } },
      ],
    },
  });
  assert.ok(!response.isError);
  const batch = response.structuredContent;
  assert.equal(snapshots, 8);
  assert.equal(submissions, 1);
  assert.equal(batch.results.at(-1).result.status, 'handled');
  assert.ok(toolResultBytes(batch) <= TOOL_RESULT_LIMIT);
  for (const { result, error } of batch.results.slice(0, 8)) {
    assert.equal(error, undefined);
    const next = await follow(f, result.next_cursor);
    assert.equal(result.leaf_id, 'a');
    assert.equal(next.leaf_id, 'a');
    assert.equal(result.items.at(-1).part + 1, next.items[0].part);
    assert.ok(!JSON.stringify(next).includes('LATER_MUTATION'));
  }
  assert.equal(snapshots, 8, 'No reacquisition for cursor pages or budget resizing');
});

test('read contract mismatch requests component update without sending an old operation or taking over', async (t) => {
  const f = await fixture(t, [message('u', null, 'user', 'task')]);
  const owner = await reserveHostSession({
    buildSessionProjection: hostProjection,
    attachmentDir: f.config.attachmentDir,
    session: f.saved,
  });
  f.cleanup.push(() => owner.close());
  await owner.ready({
    state: () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id }),
    snapshot: () => ({
      sessionFile: f.saved.file,
      sessionId: f.saved.header.id,
      entries: [],
      leafId: null,
    }),
    submit: () => assert.fail('No prompt during read'),
  });
  const runtime = await f.bridge.pool.forRead(f.saved);
  assert.equal(runtime.record.readContract, READ_CONTRACT);
  assert.equal(runtime.record.bridgeVersion, packageInfo.version);
  await updateOwner(f.config.attachmentDir, f.saved, runtime.record, {
    bridgeVersion: 'different-product-version',
  });
  await runtime.readFeatures();
  const snapshot = await runtime.read({ session_id: f.id });
  assert.equal(snapshot.contract, READ_CONTRACT);
  assert.throws(
    () => assertReadSnapshot({ ...snapshot, contract: 'unsupported' }),
    /OWNER_READ_REFRESH_REQUIRED/,
  );
  t.mock.method(runtime, 'request', () => assert.fail('Do not probe an incompatible owner'));
  for (const declared of [undefined, 'not-the-current-read-contract']) {
    runtime.record.readContract = declared;
    await f.error({}, 'OWNER_READ_REFRESH_REQUIRED');
  }
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.saved, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
  assert.equal(f.bridge.pool.instances.get(f.id), runtime);
});

test('live owners use the bound native projection after PATH/config changes, including historical leaves', async (t) => {
  const entries = [
    message('u', null, 'user', 'FIRST_TASK'),
    message('a', 'u', 'assistant', 'FIRST_REPLY'),
    message('later', 'a', 'user', 'LATER_TASK'),
  ];
  for (const kind of ['host', 'companion']) {
    const f = await fixture(t, entries),
      leaves = [];
    const buildSessionProjection = (...args) => {
      leaves.push(args[1]);
      return hostProjection(...args);
    };
    if (kind === 'host') {
      const owner = await reserveHostSession({
        attachmentDir: f.config.attachmentDir,
        session: f.saved,
        buildSessionProjection,
      });
      f.cleanup.push(() => owner.close());
      await owner.ready({
        state: () => ({ sessionFile: f.saved.file, sessionId: f.saved.header.id }),
        snapshot: () => ({
          sessionFile: f.saved.file,
          sessionId: f.saved.header.id,
          entries,
          leafId: 'later',
        }),
        submit: () => assert.fail('Read must not submit'),
      });
    } else {
      const { default: companion } = await import('../src/companion.mjs');
      const previous = process.env.PI_MCP_ATTACH_DIR,
        handlers = {};
      process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
      await companion(
        {
          getThinkingLevel: () => 'off',
          on: (event, fn) => {
            handlers[event] = fn;
          },
        },
        { buildSessionProjection },
      );
      await handlers.session_start(
        {},
        {
          mode: 'tui',
          sessionManager: SessionManager.open(f.saved.file),
          isIdle: () => true,
          hasPendingMessages: () => false,
        },
      );
      f.cleanup.push(async () => {
        await handlers.session_shutdown?.({ reason: 'quit' });
        if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
        else process.env.PI_MCP_ATTACH_DIR = previous;
      });
    }
    const runtime = await f.bridge.pool.forRead(f.saved),
      previousPath = process.env.PATH;
    f.bridge.config.piExecutable = path.join(f.dir, 'removed-pi');
    process.env.PATH = '';
    try {
      const current = await runtime.read({ session_id: f.id });
      const historical = await runtime.read({ session_id: f.id, leaf_id: 'a' });
      assert.equal(current.leaf_id, 'later');
      assert.equal(historical.leaf_id, 'a');
      assert.ok(!JSON.stringify(historical).includes('LATER_TASK'));
      assert.deepEqual(leaves, ['later', 'a']);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  }
});

test('saved and owned reads omit old image bytes before capture, but raw fork snapshots and later pages retain their native semantics', async (t) => {
  const data = 'A'.repeat(512 * 1024),
    entries = [
      message('system', null, 'system', 'OWNED_RULES', {
        toolsAdded: [{ name: 'owned_tool', parameters: { type: 'object' } }],
      }),
      message(
        'old',
        'system',
        'user',
        [text('OLD_IMAGE'), { type: 'image', mimeType: 'image/png', data }],
        { details: { type: 'image', data: 'BUSINESS_DATA' } },
      ),
      {
        type: 'custom_message',
        id: 'custom',
        parentId: 'old',
        customType: 'image-context',
        timestamp: '2026-01-01T00:00:00Z',
        content: [{ type: 'image', mimeType: 'image/png', data }],
        display: false,
      },
      message('latest', 'custom', 'user', 'LATEST_TASK'),
      message('answer', 'latest', 'assistant', [text(paragraphs(80))]),
    ],
    f = await fixture(t, entries),
    disk = await fs.readFile(f.saved.file);
  const compact = await loadSavedSession(f.saved, { omitImageData: true }),
    raw = await loadSavedSession(f.saved);
  assert.equal(compact.entries.find((e) => e.id === 'old').message.content[1].data, undefined);
  assert.equal(raw.entries.find((e) => e.id === 'old').message.content[1].data, data);
  assert.equal(compact.entries.find((e) => e.id === 'old').message.details.data, 'BUSINESS_DATA');
  assert.equal(compact.entries.find((e) => e.id === 'custom').content[0].data, undefined);
  assert.equal(raw.entries.find((e) => e.id === 'custom').content[0].data, data);
  const saved = await f.ok({ max_bytes: 4096 });
  assert.equal(saved.source, 'saved');
  assert.deepEqual(await fs.readFile(f.saved.file), disk);
  const rpc = await f.bridge.pool.resolve(f.saved),
    dispatch = rpc.dispatch.bind(rpc);
  let snapshots = 0;
  t.mock.method(rpc, 'dispatch', (command, ...args) => {
    if (command.type === 'get_entries') snapshots++;
    return dispatch(command, ...args);
  });
  const before = await fs.readFile(f.saved.file),
    owned = await f.ok({ max_bytes: 4096 });
  assert.equal(owned.source, 'rpc');
  const expand = async (page) =>
    chronological(
      await allPages(
        f,
        await f.ok({
          refs: page.items.map((item) => item.ref),
          max_bytes: 65536,
        }),
      ),
    );
  assert.deepEqual(
    await expand(owned),
    await expand(saved),
    'Saved and owned captures retain the same source content despite different page metadata',
  );
  assert.equal(snapshots, 0, 'ordinary read must not transfer the raw native log');
  const pages = await allPages(f, owned);
  assert.equal(pages.at(-1).next_cursor, null);
  assert.ok(JSON.stringify(pages).includes('LATEST_TASK'));
  assert.ok(!JSON.stringify(pages).includes(data));
  assert.ok(pages.every((page) => page.omissions.selection.system === 1));
  assert.ok(!pages.flatMap((page) => page.items).some((unit) => unit.type === 'system'));
  assert.ok(!pages.flatMap((page) => page.items).some((unit) => unit.message?.toolsAdded));
  const full = await rpc.read({ session_id: f.id, range: { recent: -1 }, content: ALL_CONTENT });
  assert.ok(full.units.some((unit) => unit.message?.content === 'OWNED_RULES'));
  assert.ok(full.units.some((unit) => unit.message?.toolsAdded?.[0].name === 'owned_tool'));
  assert.deepEqual(await fs.readFile(f.saved.file), before);
  const fork = await rpc.entries();
  assert.deepEqual(fork.entries.find((entry) => entry.id === 'system').message, entries[0].message);
  assert.equal(snapshots, 1);
  assert.equal(fork.entries.find((e) => e.id === 'old').message.content[1].data, data);
  assert.equal(fork.leafId, owned.leaf_id);
});
