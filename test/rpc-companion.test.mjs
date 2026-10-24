import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from './fixtures/pi.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import { AttachedRuntime, readClaim, ownerAlive } from '../src/attachments.mjs';

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(10);
  }
  throw new Error('COMPANION_FIXTURE_TIMEOUT');
}
const text = (entry) =>
  entry.type === 'message' && entry.message?.role === 'user'
    ? typeof entry.message.content === 'string'
      ? entry.message.content
      : entry.message.content.map((part) => part.text ?? '').join('')
    : '';

test(
  'ordinary RPC and remote MCP share native owner, bounded live reads and explicit dispatch without an admission claim',
  { timeout: 30000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-companion-'),
      cwd = path.join(dir, 'project'),
      agentDir = path.join(dir, 'agent');
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    await fs.writeFile(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({
        cacheWarming: 'off',
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
    );
    const config = {
      herdr: true,
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: cwd }],
      grants: [
        {
          folder: cwd,
          list: true,
          read: true,
          send: true,
          stop: true,
          command: true,
          delete: true,
          create: true,
        },
      ],
      attachmentDir: path.join(dir, 'ipc'),
    };
    const configFile = path.join(dir, 'owner.json');
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    const setup = await new Bridge(config).init(),
      made = await savedSession(setup),
      saved = await setup.session(made.session_id);
    await setup.close();
    const env = Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined]));
    Object.assign(env, {
      PATH: process.env.PATH,
      HOME: dir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_OFFLINE: '1',
      PI_MCP_ATTACH_DIR: config.attachmentDir,
    });
    const local = new RpcClient({
      cliPath: nativePiCli,
      cwd,
      env,
      provider: 'bridge-fixture',
      model: 'deterministic',
      args: [
        '--session',
        saved.file,
        '-e',
        path.resolve('test/fixtures/faux-extension.mjs'),
        '-e',
        path.resolve('src/attach-extension.mjs'),
      ],
    });
    let remote = new Client({ name: 'companion-fixture', version: '1' });
    const connect = () =>
      remote.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [path.resolve('src/server.mjs'), configFile],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH, HOME: dir, PI_OFFLINE: '1' },
          stderr: 'pipe',
        }),
      );
    t.after(async () => {
      await remote.close();
      await local.stop();
      await fs.rm(dir, { recursive: true, force: true });
    });
    await local.start();
    await local.getState();
    const owner = await readClaim(config.attachmentDir, saved);
    assert.equal(owner.kind, 'extension');
    assert.equal(owner.phase, 'ready');
    await connect();
    const call = async (name, args) => remote.callTool({ name, arguments: args });
    const ok = async (name, args) => {
      const response = await call(name, args);
      assert.ok(!response.isError, JSON.stringify(response));
      return response.structuredContent;
    };
    assert.deepEqual((await remote.listTools()).tools.map((x) => x.name).sort(), [
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
    assert.equal(
      (
        await ok('command', {
          session_id: saved.id,

          command: 'MUST_NOT_EXECUTE',
        })
      ).reason,
      'BASH_UNSUPPORTED',
    );
    assert.equal((await ok('stop', { session_id: saved.id })).reason, 'STOP_UNSUPPORTED');
    assert.equal((await call('read', { session_id: saved.id, view: 'raw' })).isError, true);
    const initial = await ok('read', { session_id: saved.id, max_bytes: 4096 });
    assert.equal(initial.session_id, saved.id);
    const submitted = await ok('send', {
      session_id: saved.id,

      text: 'REMOTE_ORDINARY_RPC',
    });
    assert.equal(submitted.status, 'dispatched');
    assert.equal(submitted.admission, 'unobservable');
    const live = await until(async () => {
      const result = await ok('read', { session_id: saved.id, max_bytes: 4096 });
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 4096);
      return result.live?.items?.some((unit) => unit.type === 'text' && unit.block.text)
        ? result
        : null;
    });
    assert.equal(live.live.source, 'extension_message_events');
    assert.equal(live.live.transient, true);
    const queued = await ok('send', {
      session_id: saved.id,

      text: 'DEFAULT_BUSY_INPUT',
    });
    assert.equal(queued.status, 'dispatched');
    assert.equal(queued.admission, 'unobservable');
    await until(
      async () =>
        !(await local.getState()).isStreaming && (await local.getState()).pendingMessageCount === 0,
    );
    const history = await ok('read', { session_id: saved.id, preset: 'recent' });
    assert.ok(history.items.some((item) => item.type === 'text'));
    assert.deepEqual(history.live.items, []);
    const entries = (await local.getEntries()).entries;
    assert.equal(entries.filter((entry) => text(entry) === 'REMOTE_ORDINARY_RPC').length, 1);
    assert.equal(entries.filter((entry) => text(entry) === 'DEFAULT_BUSY_INPUT').length, 1);
    const attached = new AttachedRuntime(config, saved, owner),
      snapshot = await attached.snapshot();
    assert.equal(snapshot.sessionId, saved.header.id);
    assert.deepEqual(snapshot.entries, entries);
    await assert.rejects(attached.request('shutdown'), /HOST_RELEASE_UNSUPPORTED/);
    await remote.close();
    assert.equal(await ownerAlive(owner.owner), true);
    remote = new Client({ name: 'companion-restart', version: '1' });
    await connect();

    await local.switchSession(saved.file);
    await local.getState();
    const replacement = await until(async () => {
      const value = await readClaim(config.attachmentDir, saved);
      return value?.phase === 'ready' && value.generation !== owner.generation ? value : null;
    });
    assert.equal(replacement.owner.pid, owner.owner.pid);
    config.grants.push({ session_id: saved.id, read: false, send: true });
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    assert.equal((await call('read', { session_id: saved.id })).isError, true);
    const sendOnly = await ok('send', {
      session_id: saved.id,

      text: 'SEND_ONLY_NO_TRANSCRIPT',
    });
    assert.equal(sendOnly.status, 'dispatched');
    assert.equal(JSON.stringify(sendOnly).includes('SEND_ONLY_NO_TRANSCRIPT'), false);
    await until(async () => !(await local.getState()).isStreaming);
    config.grants.push({ session_id: saved.id, read: true, send: true });
    await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
    await fs.rename(replacement.socket, replacement.socket + '.paused');
    try {
      assert.equal((await call('read', { session_id: saved.id })).isError, true);
      const rejected = await ok('send', {
        session_id: saved.id,

        text: 'NO_FALLBACK_WRITER',
      });
      assert.equal(rejected.reason, 'LIVE_OWNER_UNREACHABLE');
      assert.equal(await ownerAlive(owner.owner), true);
      assert.equal(
        (await readClaim(config.attachmentDir, saved)).generation,
        replacement.generation,
      );
      assert.ok(
        !(await local.getEntries()).entries.some((entry) => text(entry) === 'NO_FALLBACK_WRITER'),
      );
    } finally {
      await fs.rename(replacement.socket + '.paused', replacement.socket);
    }
    const deleted = await ok('delete', { session_id: saved.id });
    assert.equal(deleted.status, 'deleted', JSON.stringify(deleted));
    assert.equal(deleted.recoverable, true);
    assert.equal(await ownerAlive(owner.owner), false);
    await assert.rejects(fs.stat(saved.file), { code: 'ENOENT' });
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(config.stateDir, 'trash', deleted.restore_token + '.restore.json'),
        'utf8',
      ),
    );
    assert.match(await fs.readFile(manifest.trash_path, 'utf8'), /REMOTE_ORDINARY_RPC/);
  },
);
