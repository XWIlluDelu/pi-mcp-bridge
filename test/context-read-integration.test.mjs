import { READ_CONTRACT, assertReadSnapshot } from '../src/context-read.mjs';
import { buildSessionProjection as hostProjection } from './fixtures/pi.mjs';
import { test } from 'node:test';
import packageInfo from '../package.json' with { type: 'json' };
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { AgentSession, SessionManager } from './fixtures/pi.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Bridge } from '../src/bridge.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import { readSource } from './fixtures/read-source.mjs';

import { makeServer } from '../src/server.mjs';
import { assertContextReadResponse } from './fixtures/read-pages.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { reserveOwner, updateOwner } from '../src/attachments.mjs';
import attachExtension from './fixtures/companion.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

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

const paragraphs = (n = 80) =>
  Array.from({ length: n }, (_, i) => 'Paragraph-' + i + ' 漢😀"\\ '.repeat(20) + '\n\n').join('');

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
          getAllTools: () => [],
          getCommands: () => [],
          registerCommand: () => {},
          on: (event, fn) => {
            handlers[event] = fn;
          },
        },
        { AgentSession, buildSessionProjection },
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
