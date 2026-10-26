import { readSource } from './fixtures/read-source.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import packageInfo from '../package.json' with { type: 'json' };
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import {
  AttachedRuntime,
  readClaim,
  claimFile,
  processIdentity,
  reserveOwner,
  updateOwner,
  releaseOwner,
  ownerAlive,
  privateDirectory,
  registryTransaction,
  assertNoOtherLiveOwner,
  waitOwnerExit,
} from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { publicOperationSchemas } from '../src/tool-schemas.mjs';
const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-at-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
    attachmentDir: path.join(dir, 'ipc'),
    attachmentExitTimeoutMs: 4000,
  };
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge);
  const session = await bridge.session(made.session_id);
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, cwd, config, bridge, session, id: made.session_id };
}
async function until(fn, timeout = 12000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw last ?? new Error('Fixture deadline');
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
async function tui(t, f, { expectFailure = false } = {}) {
  const agentDir = path.join(f.dir, 'agent');
  await fs.mkdir(agentDir);
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
  );
  const commands = path.join(f.dir, 'commands.mjs');
  await fs.writeFile(
    commands,
    `export default function(pi){pi.registerCommand('fixture-reload',{handler:async(_a,ctx)=>{await ctx.reload();}});pi.registerCommand('fixture-switch',{handler:async(_a,ctx)=>{await ctx.newSession({setup:async manager=>{manager.appendMessage({role:'user',content:'replacement public fixture',timestamp:Date.now()});}});}});pi.registerCommand('fixture-fork',{handler:async(_a,ctx)=>{await ctx.fork(ctx.sessionManager.getEntries().find(e=>e.type==='message'&&e.message.role==='user').id,{position:'at'});}});pi.registerCommand('fixture-resume',{handler:async(args,ctx)=>{await ctx.switchSession(args.trim());}});}`,
  );
  const args = [
    process.execPath,
    nativePiCli,
    '--session',
    f.session.file,
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-tools',
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '-e',
    path.join(base, 'src/attach-extension.mjs'),
    '-e',
    commands,
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  ];
  const child = spawn('script', ['-qefc', args.map(quote).join(' '), '/dev/null'], {
    cwd: f.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_ATTACH_DIR: f.config.attachmentDir,
      PI_OFFLINE: '1',
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-24000);
  });
  child.stderr.on('data', (chunk) => {
    log = (log + chunk.toString()).slice(-24000);
  });
  let record;
  t.after(async () => {
    // Clean up any TUI left alive by a test that did not delete it.
    if (record && (await ownerAlive(record.owner))) process.kill(record.owner.pid, 'SIGTERM');
    child.stdin.destroy();
    if (child.exitCode === null) child.kill('SIGTERM');
  });
  if (expectFailure) return { child, getLog: () => log };
  try {
    record = await until(async () => {
      const r = await readClaim(f.config.attachmentDir, f.session);
      return r?.phase === 'ready' ? r : null;
    });
  } catch (e) {
    throw new Error('TUI startup failed: ' + log.slice(-3000), { cause: e });
  }
  return { child, record, getLog: () => log };
}

test('private registry rejects group-readable directory and live owner prevents RPC fallback', async (t) => {
  const f = await fixture(t);
  const record = await reserveOwner(f.config.attachmentDir, f.session, 'tui');
  const sent = await f.bridge.send({
    session_id: f.id,

    text: 'never dispatch',
  });
  assert.equal(sent.status, 'rejected');
  assert.equal(sent.reason, 'LIVE_OWNER_UNREACHABLE');
  assert.equal(f.bridge.pool.instances.size, 0);
  await assert.rejects(f.bridge.read({ session_id: f.id }), /LIVE_OWNER_UNREACHABLE/);
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
  await releaseOwner(f.config.attachmentDir, f.session, record);
  const bad = path.join(f.dir, 'bad');
  await fs.mkdir(bad);
  await fs.chmod(bad, 0o755);
  await assert.rejects(privateDirectory(bad), /INVALID_ATTACHMENT_DIRECTORY/);
});

test('overlong attachment path prevents bridge startup and official TUI exits on registration failure', async (t) => {
  const f = await fixture(t);
  await f.bridge.close();
  f.config.attachmentDir = path.join(f.dir, 'x'.repeat(80));
  await assert.rejects(new Bridge(f.config).init(), /ATTACHMENT_SOCKET_PATH_TOO_LONG/);
  const launched = await tui(t, f, { expectFailure: true });
  await until(() => launched.child.exitCode !== null);
  assert.ok(launched.getLog().includes('ATTACHMENT_SOCKET_PATH_TOO_LONG'));
  assert.ok(await fs.stat(f.session.file));
  assert.equal(f.bridge.pool.instances.size, 0);
});

test('delete cannot terminate its own shared process; disconnect leaves it alive', async (t) => {
  const f = await fixture(t);
  const record = await reserveOwner(f.config.attachmentDir, f.session, 'tui');
  const server = net.createServer((socket) =>
    socket.once('data', (chunk) =>
      socket.end(
        JSON.stringify({
          generation: record.generation,
          ...(JSON.parse(chunk.toString()).op === 'set_model'
            ? { error: 'MODEL_SELECTION_UNSUPPORTED' }
            : { data: { shutdown: 'requested' } }),
        }) + '\n',
      ),
    ),
  );
  await new Promise((r) => server.listen(record.socket, r));
  t.after(() => new Promise((r) => server.close(r)));
  await updateOwner(f.config.attachmentDir, f.session, record, { phase: 'ready' });
  const runtime = new AttachedRuntime(
    { ...f.config, attachmentExitTimeoutMs: 40 },
    f.session,
    record,
  );
  await assert.rejects(
    runtime.selectModel(undefined, { thinkingLevel: 'high' }),
    (e) => e.message === 'MODEL_SELECTION_UNSUPPORTED' && e.uncertain === false,
  );
  await assert.rejects(runtime.stopForDelete(), /DELETE_SHARED_OWNER/);
  assert.equal(await ownerAlive(record.owner), true);
  assert.ok(await fs.stat(f.session.file));
  await runtime.stop();
  assert.equal(await ownerAlive(record.owner), true);
});

test('conclusively dead registered owner permits claimed RPC fallback without a model call', async (t) => {
  const f = await fixture(t);
  await reserveOwner(f.config.attachmentDir, f.session, 'tui', {
    pid: process.pid,
    start: '0',
    boot: 'expired-boot',
  });
  const runtime = await f.bridge.pool.resolve(f.session);
  assert.equal(runtime.attached, undefined);
  assert.equal((await runtime.state()).sessionId, f.session.header.id);
  const claim = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(claim.kind, 'rpc');
  assert.equal(await ownerAlive(claim.owner), true);
  await f.bridge.close();
  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
});

test('deletion excludes new writers until the caller finishes the filesystem move', async (t) => {
  const f = await fixture(t);
  const release = await f.bridge.pool.stopForDelete(f.session);
  const neighbor = await f.bridge.session((await savedSession(f.bridge)).session_id);
  const neighborOwner = await reserveOwner(f.config.attachmentDir, neighbor, 'rpc');
  await releaseOwner(f.config.attachmentDir, neighbor, neighborOwner);
  // Companion pre-open checks must not bypass deletion for a same-process switch.
  await assert.rejects(
    registryTransaction(f.config.attachmentDir, () =>
      assertNoOtherLiveOwner(
        f.config.attachmentDir,
        { file: f.session.file },
        { allowSameProcess: true },
      ),
    ),
    /LIVE_OWNER_UNREACHABLE/,
  );
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'tui'),
    /LIVE_OWNER_UNREACHABLE/,
  );
  await release();
  const owner = await reserveOwner(f.config.attachmentDir, f.session, 'tui');
  await releaseOwner(f.config.attachmentDir, f.session, owner);
});

test('attachment deletion timeout is a bounded owner setting', async (t) => {
  const f = await fixture(t);
  for (const attachmentExitTimeoutMs of ['5000', 0, 30001, Infinity])
    await assert.rejects(
      new Bridge({ ...f.config, attachmentExitTimeoutMs }).init(),
      /INVALID_OWNER_CONFIG/,
    );
});

test('extension confirms public dispatch without claiming admission, and idle includes compaction', async (t) => {
  const f = await fixture(t);
  const unrelated = { file: path.join(f.dir, 'unrelated.jsonl'), header: { id: 'unrelated' } };
  const unrelatedRecord = {
    file: unrelated.file,
    sessionId: unrelated.header.id,
    kind: 'rpc',
    generation: 'unrelated-generation',
    owner: null,
    phase: 'ready',
    unexpected: true,
  };
  const unrelatedFile = claimFile(f.config.attachmentDir, unrelated);
  await fs.writeFile(unrelatedFile, JSON.stringify(unrelatedRecord), { mode: 0o600 });
  const original = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {},
    calls = [];
  let idle = true,
    shutdown = false,
    leaf = 'b';
  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    sendUserMessage: (text, options) => calls.push({ text, options }),
  };
  await attachExtension(pi);
  const entries = [
    {
      type: 'message',
      id: 'a',
      parentId: null,
      message: { role: 'user', content: 'a'.repeat(6000) },
    },
    {
      type: 'message',
      id: 'b',
      parentId: null,
      message: { role: 'user', content: 'b'.repeat(6000) },
    },
  ];
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getHeader: () => f.session.header,
      getSessionId: () => f.session.header.id,
      getEntries: () => entries,
      getLeafId: () => leaf,
    },
    isIdle: () => idle,
    hasPendingMessages: () => false,
    shutdown: () => {
      shutdown = true;
    },
  };
  try {
    await handlers.session_start({ reason: 'startup' }, ctx);
    const record = await readClaim(f.config.attachmentDir, f.session);
    const runtime = new AttachedRuntime(f.config, f.session, record);
    for (const input of [{}, { mode: 'idle_only' }, { mode: 'follow_up' }]) {
      const result = await runtime.send({ text: 'public fixture', ...input });
      assert.deepEqual(result, { status: 'dispatched', admission: 'unobservable' });
    }
    assert.deepEqual(
      calls.map((x) => x.options),
      [
        { expandPromptTemplates: true, deliverAs: 'steer' },
        { expandPromptTemplates: true },
        { expandPromptTemplates: true, deliverAs: 'followUp' },
      ],
    );
    await assert.rejects(
      runtime.send({
        text: 'fenced-before-socket-write',
        beforeDispatch: () => {
          throw new Error('STOP_IN_PROGRESS');
        },
      }),
      (error) => error.message === 'STOP_IN_PROGRESS' && !error.uncertain,
    );
    assert.equal(calls.length, 3);
    idle = false;
    assert.equal((await runtime.send({ text: 'compacting', mode: 'idle_only' })).status, 'skipped');
    assert.equal(calls.length, 3);
    const escaped = {
      session_id: f.id,

      text: '\0'.repeat(100000),
    };
    assert.equal(publicOperationSchemas.send.safeParse(escaped).success, true);
    assert.equal((await runtime.send(escaped)).status, 'dispatched');
    assert.equal(calls.at(-1).text, escaped.text);
    const throwing = t.mock.method(pi, 'sendUserMessage', () => {
      throw new Error('PRIVATE_NATIVE_DISPATCH_FAILURE');
    });
    assert.deepEqual(await runtime.send({ text: 'uncertain invocation' }), {
      status: 'unknown',
      reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
    });
    throwing.mock.restore();
    f.bridge.pool.instances.set(f.id, runtime);
    const connect = t.mock.method(net, 'createConnection', () => {
      throw new Error('oversized requests must not connect');
    });
    try {
      await assert.rejects(
        f.bridge.send({
          ...escaped,

          text: '\0'.repeat(200000),
        }),
        /INVALID_ARGUMENTS/,
      );
      await assert.rejects(
        runtime.send({ ...escaped, text: '\0'.repeat(2 * 1024 * 1024) }),
        /ATTACHMENT_REQUEST_TOO_LARGE/,
      );
      assert.equal(connect.mock.calls.length, 0);
    } finally {
      connect.mock.restore();
    }
    const captured = await runtime.read({ session_id: f.id, max_bytes: 4096 });
    assert.equal(captured.leaf_id, 'b');
    assert.ok(Array.isArray(captured.units));
    const before = JSON.stringify(captured);
    leaf = 'a';
    const next = await runtime.read({ session_id: f.id });
    assert.equal(next.leaf_id, 'a');
    entries[1].message.content = 'edited';
    assert.equal(
      JSON.stringify(captured),
      before,
      'Owner snapshots are detached, not moving views',
    );
    await assert.rejects(
      runtime.read({ session_id: f.id, cursor: 'unsupported-owner-cursor' }),
      /INVALID_READ_ARGUMENTS/,
    );
    await runtime.stop();
    assert.equal(shutdown, false);
    await handlers.session_shutdown({ reason: 'reload' }, ctx);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'transitioning');
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
    const previous = await readClaim(f.config.attachmentDir, f.session);
    delete previous.readContract;
    await fs.writeFile(
      claimFile(f.config.attachmentDir, f.session),
      JSON.stringify({ ...previous, unsupportedControlMetadata: true }),
    );
    await handlers.session_start({ reason: 'reload' }, ctx);
    const refreshed = await readClaim(f.config.attachmentDir, f.session);
    assert.notEqual(refreshed.generation, record.generation);
    assert.equal(refreshed.readContract, packageInfo.version);
    assert.equal(refreshed.unsupportedControlMetadata, undefined);
    assert.equal(shutdown, false);
    assert.deepEqual(JSON.parse(await fs.readFile(unrelatedFile, 'utf8')), unrelatedRecord);
  } finally {
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    if (original === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = original;
  }
});

test('same session continues headless after actual TUI exit with history, grants, profile and restart receipt intact', async (t) => {
  const f = await fixture(t),
    profile = path.join(f.dir, 'headless-marker.mjs');
  await fs.writeFile(
    profile,
    "export default function(pi){pi.on('session_start',()=>pi.appendEntry('headless-profile',{fixture:true}));}",
  );
  f.config.piArgs = [
    '--offline',
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '-e',
    profile,
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  ];
  const launched = await tui(t, f);
  const first = await f.bridge.send({
    session_id: f.id,

    text: 'PUBLIC_TUI_HISTORY',
  });
  assert.equal(first.dispatch, undefined);
  await until(async () => {
    const r = await f.bridge.read({
      session_id: f.id,
      range: { recent: -1 },
      content: ALL_CONTENT,
    });
    return (
      r.items.some((x) => x.type === 'assistant') &&
      !(await f.bridge.pool.get(f.id).state()).isStreaming
    );
  });
  process.kill(launched.record.owner.pid, 'SIGTERM');
  await waitOwnerExit(launched.record.owner);
  assert.equal((await f.bridge.session(f.id)).file, f.session.file);
  f.config.grants.push({ session_id: f.id, send: false });
  assert.equal(
    (
      await f.bridge.send({
        session_id: f.id,

        text: 'MUST_NOT_DISPATCH',
      })
    ).status,
    'rejected',
  );
  const afterDenial = await readClaim(f.config.attachmentDir, f.session);
  assert.ok(!afterDenial || !(await ownerAlive(afterDenial.owner)));
  f.config.grants.push({ session_id: f.id, send: true });
  const second = await f.bridge.send({
    session_id: f.id,

    text: 'PUBLIC_HEADLESS_CONTINUATION',
    mode: 'idle_only',
  });
  assert.ok(['started', 'queued', 'handled'].includes(second.status), JSON.stringify(second));
  assert.equal(second.status, 'started');
  const claim = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(claim.kind, 'rpc');
  assert.equal(claim.sessionId, f.session.header.id);
  assert.equal(await ownerAlive(claim.owner), true);
  assert.notEqual(claim.generation, launched.record.generation);
  assert.equal(f.bridge.pool.instances.size, 1);
  await until(async () => {
    const r = await f.bridge.read({
      session_id: f.id,
      range: { recent: -1 },
      content: ALL_CONTENT,
    });
    return r.items.filter((x) => x.type === 'assistant').length === 2;
  });
  const raw = await loadSavedSession(f.session);
  assert.ok(raw.entries.some((x) => x.customType === 'headless-profile'));
  const history = JSON.stringify(raw);
  assert.ok(history.includes('PUBLIC_TUI_HISTORY'));
  assert.ok(history.includes('PUBLIC_HEADLESS_CONTINUATION'));
  assert.ok(!history.includes('MUST_NOT_DISPATCH'));
  const beforeClose = await readSource(f.bridge, {
    session_id: f.id,
    range: { recent: -1 },
    content: ALL_CONTENT,
    max_bytes: 65536,
  });
  await f.bridge.close();
  assert.equal(await ownerAlive(claim.owner), false);
  const restarted = await new Bridge(f.config).init();
  try {
    await assert.rejects(restarted.send({ session_id: f.id }), /INVALID_ARGUMENTS/);
    assert.equal(restarted.pool.instances.size, 0);
    assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
    const read = await loadSavedSession(await restarted.session(f.id));
    assert.deepEqual(read.entries, raw.entries);
    const publicRead = await readSource(restarted, {
      session_id: f.id,
      range: { recent: -1 },
      content: ALL_CONTENT,
      max_bytes: 65536,
    });
    assert.deepEqual(publicRead.items, beforeClose.items);
  } finally {
    await restarted.close();
  }
});

test('official offline Pi TUI attaches, sends all modes, reloads, resumes attachment and deletes after exit', async (t) => {
  const f = await fixture(t);
  const owned = await f.bridge.pool.resolve(f.session),
    old = owned.ownerRecord.owner;
  await f.bridge.releaseForLocal({ session_id: f.id });
  assert.equal(await ownerAlive(old), false);
  const launched = await tui(t, f);
  const receipt = await f.bridge.send({
    session_id: f.id,

    // Force source pagination independently of the number of send modes below.
    text: 'first public fixture\n' + 'captured source '.repeat(500),
  });
  assert.equal(receipt.status, 'dispatched');
  assert.equal(receipt.admission, 'unobservable');
  assert.equal(receipt.dispatch, undefined);
  assert.equal(
    (
      await f.bridge.send({
        session_id: f.id,

        text: 'must skip',
        mode: 'idle_only',
      })
    ).status,
    'skipped',
  );
  for (const mode of ['steer', 'follow_up']) {
    const r = await f.bridge.send({
      session_id: f.id,

      text: 'busy ' + mode,
      mode,
    });
    assert.equal(r.status, 'dispatched');
    assert.equal(r.admission, 'unobservable');
    assert.equal(r.dispatch, undefined);
  }

  // Queue consumption may combine inputs in one native loop. Verify native
  // user history, not one assistant response per external submission.
  const expectedInputs = ['first public fixture', 'busy steer', 'busy follow_up'];
  await until(async () => {
    const native = await loadSavedSession(f.session);
    const inputs = native.entries
      .filter((entry) => entry.type === 'message' && entry.message.role === 'user')
      .map((entry) => JSON.stringify(entry.message.content));
    return expectedInputs.every((text) => inputs.some((input) => input.includes(text)));
  });
  assert.equal(f.bridge.pool.get(f.id).attached, true);
  assert.equal(
    (await readClaim(f.config.attachmentDir, f.session)).generation,
    launched.record.generation,
  );
  await until(async () => !(await f.bridge.pool.get(f.id).state()).isStreaming);
  for (const mode of ['idle_only', 'steer', 'follow_up']) {
    const r = await f.bridge.send({
      session_id: f.id,

      text: 'idle ' + mode,
      mode,
    });
    assert.equal(r.status, 'dispatched');
    await until(async () => !(await f.bridge.pool.get(f.id).state()).isStreaming);
  }
  const page = await f.bridge.read({
    session_id: f.id,
    range: { recent: -1 },
    content: ALL_CONTENT,
    max_bytes: 4096,
  });
  assert.ok(page.next_cursor);
  const beforeReload = await f.bridge.read({
    session_id: f.id,
    range: { recent: -1 },
    content: ALL_CONTENT,
    cursor: page.next_cursor,
  });
  assert.equal(JSON.stringify(await loadSavedSession(f.session)).includes('must skip'), false);
  const oldGeneration = launched.record.generation;
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: '/fixture-reload' })).status,
    'dispatched',
  );
  await until(async () => {
    const r = await readClaim(f.config.attachmentDir, f.session);
    return r?.phase === 'ready' && r.generation !== oldGeneration;
  });
  const afterReload = await f.bridge.read({
    session_id: f.id,
    range: { recent: -1 },
    content: ALL_CONTENT,
    cursor: page.next_cursor,
  });
  assert.deepEqual(afterReload.items, beforeReload.items);
  await f.bridge.close();
  assert.equal(await ownerAlive(launched.record.owner), true);
  const restarted = await new Bridge(f.config).init();
  t.after(() => restarted.close());

  assert.ok(
    (await restarted.read({ session_id: f.id, range: { recent: -1 }, content: ALL_CONTENT })).items
      .length > 0,
  );
  const removed = await restarted.delete({ session_id: f.id });
  assert.equal(removed.status, 'deleted');
  assert.equal(await ownerAlive(launched.record.owner), false);
  assert.equal((await restarted.list()).sessions.length, 0);
  await restarted.close();
});

test('delayed shutdown flush cannot call a replaced or invalidated Pi context', async (t) => {
  const f = await fixture(t),
    previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {},
    callbacks = [];
  let shutdowns = 0;
  await attachExtension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const originalEnd = net.Socket.prototype.end;
  t.mock.method(net.Socket.prototype, 'end', function (...args) {
    if (
      typeof args[0] === 'string' &&
      args[0].includes('"shutdown":"requested"') &&
      typeof args[1] === 'function'
    ) {
      callbacks.push(args[1]);
      args.splice(1, 1);
    }
    return originalEnd.apply(this, args);
  });
  const manager = {
    getSessionFile: () => f.session.file,
    getHeader: () => f.session.header,
    getSessionId: () => f.session.header.id,
  };
  const context = () => {
    const state = { valid: true };
    const check = () => {
      if (!state.valid) throw new Error('Pi extension context is no longer active');
    };
    const ctx = {
      mode: 'tui',
      get sessionManager() {
        check();
        return manager;
      },
      shutdown: () => {
        check();
        shutdowns++;
      },
    };
    return { state, ctx };
  };
  let current = context();
  try {
    await handlers.session_start({ reason: 'startup' }, current.ctx);
    let runtime = new AttachedRuntime(
      f.config,
      f.session,
      await readClaim(f.config.attachmentDir, f.session),
    );
    assert.equal((await runtime.request('shutdown')).shutdown, 'requested');
    assert.equal(callbacks.length, 1);
    await handlers.session_shutdown({ reason: 'reload' }, current.ctx);
    current.state.valid = false;
    current = context();
    await handlers.session_start({ reason: 'reload' }, current.ctx);
    assert.doesNotThrow(() => callbacks.shift()());
    assert.equal(shutdowns, 0);
    runtime = new AttachedRuntime(
      f.config,
      f.session,
      await readClaim(f.config.attachmentDir, f.session),
    );
    await runtime.request('shutdown');
    current.state.valid = false;
    assert.doesNotThrow(() => callbacks.shift()());
    assert.equal(shutdowns, 0);
    current.state.valid = true;
    await runtime.request('shutdown');
    callbacks.shift()();
    assert.equal(shutdowns, 1);
  } finally {
    await handlers.session_shutdown({ reason: 'quit' }, current.ctx);
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
});

test('registry failure during shutdown still closes old socket and retains blocking ownership', async (t) => {
  const f = await fixture(t),
    previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  await attachExtension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getHeader: () => f.session.header,
      getSessionId: () => f.session.header.id,
    },
  };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let held;
  try {
    await handlers.session_start({ reason: 'startup' }, ctx);
    const record = await readClaim(f.config.attachmentDir, f.session);
    held = registryTransaction(f.config.attachmentDir, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(
      handlers.session_shutdown({ reason: 'reload' }, ctx),
      /ATTACHMENT_REGISTRY_BUSY/,
    );
    await assert.rejects(fs.stat(record.socket), { code: 'ENOENT' });
    release.resolve();
    await held;
    assert.equal(
      (await readClaim(f.config.attachmentDir, f.session)).generation,
      record.generation,
    );
    assert.equal(await ownerAlive(record.owner), true);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
  } finally {
    release.resolve();
    await held;
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
});

test('socket startup failure retains ownership; send cannot fall back and delete cannot kill its own host', async (t) => {
  const f = await fixture(t),
    previous = process.env.PI_MCP_ATTACH_DIR;
  process.env.PI_MCP_ATTACH_DIR = f.config.attachmentDir;
  const handlers = {};
  let shutdown = false;
  await attachExtension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
  });
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getHeader: () => f.session.header,
      getSessionId: () => f.session.header.id,
    },
    shutdown: () => {
      shutdown = true;
    },
  };
  const listen = net.Server.prototype.listen;
  t.mock.method(net.Server.prototype, 'listen', function (address, ...args) {
    if (typeof address === 'string' && address.startsWith('/')) {
      queueMicrotask(() => this.emit('error', new Error('injected listen failure')));
      return this;
    }
    return listen.call(this, address, ...args);
  });
  try {
    await assert.rejects(
      handlers.session_start({ reason: 'startup' }, ctx),
      /injected listen failure/,
    );
    assert.equal(shutdown, true);
    assert.equal((await readClaim(f.config.attachmentDir, f.session)).phase, 'starting');
    const sent = await f.bridge.send({
      session_id: f.id,

      text: 'must not spawn',
    });
    assert.equal(sent.status, 'rejected');
    assert.equal(sent.reason, 'LIVE_OWNER_UNREACHABLE');
    const removed = await f.bridge.delete({ session_id: f.id });
    assert.equal(removed.status, 'rejected');
    assert.equal(removed.reason, 'DELETE_SHARED_OWNER');
    assert.ok(await fs.stat(f.session.file));
    assert.equal(f.bridge.pool.instances.size, 0);
  } finally {
    await handlers.session_shutdown({ reason: 'quit' }, ctx);
    t.mock.restoreAll();
    if (previous === undefined) delete process.env.PI_MCP_ATTACH_DIR;
    else process.env.PI_MCP_ATTACH_DIR = previous;
  }
});

test('official TUI session replacement registers a fresh identity and socket loss does not spawn RPC', async (t) => {
  const f = await fixture(t);
  const launched = await tui(t, f);
  await f.bridge.send({ session_id: f.id, text: 'public fork fixture' });
  await until(async () =>
    (await f.bridge.read({ session_id: f.id })).items.some((x) => x.type === 'assistant'),
  );
  await until(async () => !(await f.bridge.pool.get(f.id).state()).isStreaming);
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: '/fixture-fork' })).status,
    'dispatched',
  );
  const fork = await until(async () => (await f.bridge.sessions()).find((s) => s.id !== f.id));
  const forkClaim = await until(async () => {
    const r = await readClaim(f.config.attachmentDir, fork);
    return r?.phase === 'ready' ? r : null;
  });
  assert.notEqual(forkClaim.generation, launched.record.generation);
  // Ready publication precedes asynchronous old-claim cleanup. Await both
  // lifecycle conditions instead of assuming they are a single transaction.
  await until(async () => (await readClaim(f.config.attachmentDir, f.session)) === null);
  assert.equal(
    (
      await f.bridge.send({
        session_id: fork.id,

        text: '/fixture-resume ' + f.session.file,
      })
    ).status,
    'dispatched',
  );
  const resumed = await until(async () => {
    const r = await readClaim(f.config.attachmentDir, f.session);
    return r?.phase === 'ready' && r.generation !== launched.record.generation ? r : null;
  });
  assert.notEqual(resumed.generation, forkClaim.generation);
  await until(async () => (await readClaim(f.config.attachmentDir, fork)) === null);
  const sent = await f.bridge.send({
    session_id: f.id,

    text: '/fixture-switch',
  });
  assert.equal(sent.status, 'dispatched');
  const replacement = await until(async () => {
    const sessions = await f.bridge.sessions();
    return sessions.find((s) => s.id !== f.id && s.id !== fork.id);
  });
  const claim = await until(async () => {
    const r = await readClaim(f.config.attachmentDir, replacement);
    return r?.phase === 'ready' ? r : null;
  });
  assert.notEqual(claim.generation, launched.record.generation);
  assert.notEqual(claim.sessionId, f.session.header.id);
  await until(async () => (await readClaim(f.config.attachmentDir, f.session)) === null);
  const read = await f.bridge.read({ session_id: replacement.id });
  assert.ok(JSON.stringify(read).includes('replacement public fixture'));
  await fs.unlink(claim.socket);
  const result = await f.bridge.send({
    session_id: replacement.id,

    text: 'do not start a second process',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'LIVE_OWNER_UNREACHABLE');
  assert.equal(await ownerAlive(claim.owner), true);
  assert.equal(f.bridge.pool.get(replacement.id).attached, true);
  const removed = await f.bridge.delete({
    session_id: replacement.id,
  });
  assert.equal(removed.status, 'deleted', JSON.stringify(removed));
  assert.equal(await ownerAlive(claim.owner), false);
  await assert.rejects(fs.stat(replacement.file), { code: 'ENOENT' });
});

test('standard MCP client attaches to an existing offline TUI through the single-operation tools alongside batch', async (t) => {
  const f = await fixture(t);
  const launched = await tui(t, f);
  await f.bridge.close();
  f.config.piArgs.push(
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  );
  const filename = path.join(f.dir, 'config.json');
  await fs.writeFile(filename, JSON.stringify(f.config), { mode: 0o600 });
  const client = new Client({ name: 'attached-mcp-fixture', version: '1.0.0' });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.join(base, 'src/server.mjs'), filename],
        cwd: base,
        env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
        stderr: 'pipe',
      }),
    );
    assert.deepEqual((await client.listTools()).tools.map((x) => x.name).sort(), [
      'batch',
      'command',
      'compact',
      'create',
      'delete',
      'health',
      'list',
      'models',
      'read',
      'search',
      'send',
      'set_model',
      'stop',
      'submission',
    ]);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError);
      return result.structuredContent;
    };
    assert.equal((await call('list', {})).sessions[0].session_id, f.id);
    const receipt = await call('send', {
      session_id: f.id,

      text: 'offline MCP TUI fixture',
    });
    assert.equal(receipt.status, 'dispatched');
    assert.equal(receipt.admission, 'unobservable');

    await until(async () => {
      const r = await call('read', { session_id: f.id });
      return r.items.some((x) => x.type === 'assistant');
    });
    const created = await call('create', {
      project: f.cwd,

      text: 'PUBLIC_CREATED_WORK',
    });
    assert.ok(['started', 'queued', 'handled'].includes(created.status), JSON.stringify(created));
    assert.equal((await call('delete', { session_id: created.session_id })).status, 'deleted');
    assert.equal((await call('delete', { session_id: f.id })).status, 'deleted');
    assert.equal(await ownerAlive(launched.record.owner), false);
  } finally {
    await client.close();
  }
});
