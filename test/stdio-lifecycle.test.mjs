import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import { isolatedRuntime, nativePiCli } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Bridge } from '../src/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { META, MODERN_VERSION } from '../src/protocol.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';
const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('Lifecycle fixture deadline');
}
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    (e) => {
      if (e.code === 'ENOENT') return false;
      throw e;
    },
  );
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-life-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const marker = path.join(dir, 'dispatch'),
    extension = path.join(dir, 'command.mjs');
  // Official RPC command dispatch exercises an in-flight receipt without a model call.
  await fs.writeFile(
    extension,
    `import fs from 'node:fs/promises'; export default function(pi){pi.registerCommand('lifecycle-fixture',{handler:async()=>{await fs.writeFile(${JSON.stringify(marker)},'started');await new Promise(r=>setTimeout(r,300));}});}`,
  );
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true }],
    attachmentDir: path.join(dir, 'ipc'),
    piArgs: ['--offline', '-e', extension],
  };
  const bridge = await new Bridge(config).init();
  const made = await savedSession(bridge);
  const session = await bridge.session(made.session_id);
  await bridge.close();
  const configFile = path.join(dir, 'owner.json');
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  return {
    dir,
    cwd,
    config,
    configFile,
    session,
    id: made.session_id,
    marker,
  };
}
function launch(t, f, nodeArgs = []) {
  const child = spawn(
    process.execPath,
    [...nodeArgs, path.join(base, 'src/server.mjs'), f.configFile],
    {
      cwd: base,
      env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stderr = '',
    next = 0;
  const pending = new Map();
  child.stderr.on('data', (b) => {
    stderr += b;
  });
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    const value = JSON.parse(line);
    const resolve = pending.get(value.id);
    if (resolve) {
      pending.delete(value.id);
      resolve(value);
    }
  });
  const done = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await done;
    lines.close();
  });
  const write = (value) => child.stdin.write(JSON.stringify(value) + '\n');
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      write({ jsonrpc: '2.0', id, method, params });
    });
  const bounded = (p) =>
    Promise.race([
      p,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP fixture timeout')), 10000);
        timer.unref();
      }),
    ]);
  const call = async (name, args) => {
    const result = (await bounded(request('tools/call', { name, arguments: args }))).result;
    assert.ok(result && !result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  return {
    child,
    call,
    request,
    done,
    stderr: () => stderr,
    initialize: async (protocolVersion = '2024-11-05') => {
      const r = await bounded(
        request('initialize', {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: 'lifecycle-fixture', version: '1' },
        }),
      );
      assert.ok(r.result);
      write({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    exit: async () => {
      const result = await bounded(done);
      assert.equal(result.signal, null, stderr);
      return result.code;
    },
  };
}
async function stopped(f, owner) {
  if (owner) assert.equal(await ownerAlive(owner), false);
  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
}
async function ownClaim(f) {
  return until(async () => {
    const r = await readClaim(f.config.attachmentDir, f.session);
    return r?.phase === 'ready' ? r : null;
  });
}

for (const stage of ['before-acquire', 'after-acquire', 'owner-listen-failure'])
  test(`stop during initialization waits for ${stage} and releases only its acquired lock`, async (t) => {
    const f = await fixture(t),
      preload = path.join(f.dir, 'pause-init.mjs'),
      reached = path.join(f.dir, 'init-reached'),
      release = path.join(f.dir, 'init-release');
    await fs.writeFile(
      preload,
      `import {holdInit} from ${JSON.stringify(new URL('./fixtures/init-gate.mjs', import.meta.url).href)};holdInit(${JSON.stringify({ config: f.config, stage, reached, release })});`,
    );
    const server = launch(t, f, ['--import', preload]);
    await until(() => exists(reached));
    server.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 80));
    server.child.kill('SIGINT');
    assert.equal(server.child.exitCode, null);
    assert.equal(
      server.child.signalCode,
      null,
      'Signal handlers must be active before init acquires resources',
    );
    await fs.writeFile(release, 'continue');
    assert.equal(await server.exit(), stage === 'owner-listen-failure' ? 1 : 0);
    await stopped(f);
    const restarted = launch(t, f);
    await restarted.initialize();
    restarted.child.stdin.end();
    assert.equal(await restarted.exit(), 0);
    await stopped(f);
  });

test('modern stdio discovers without initialize and EOF drains native input before restart', async (t) => {
  const f = await fixture(t),
    server = launch(t, f);
  const _meta = { [META + 'protocolVersion']: MODERN_VERSION, [META + 'clientCapabilities']: {} };
  const discovery = await server.request('server/discover', { _meta });
  assert.equal(discovery.result.resultType, 'complete');
  assert.ok(discovery.result.supportedVersions.includes(MODERN_VERSION));
  const missing = await server.request('tools/list', {});
  assert.equal(missing.error.code, -32602);
  const listed = await server.request('tools/list', { _meta });
  assert.ok(listed.result.tools.some((tool) => tool.name === 'compact'));
  const pending = server.request('tools/call', {
    name: 'send',
    arguments: { session_id: f.id, text: '/lifecycle-fixture' },
    _meta,
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  server.child.stdin.end();
  const response = await pending;
  assert.equal(response.result.resultType, 'complete');
  assert.equal(response.result.structuredContent.status, 'handled');
  assert.equal(await server.exit(), 0);
  await stopped(f, claim.owner);
  const second = launch(t, f);
  assert.equal(
    (
      await second.request('tools/call', {
        name: 'list',
        arguments: { session_id: f.id },
        _meta,
      })
    ).result.structuredContent.sessions.length,
    1,
  );
  second.child.stdin.end();
  assert.equal(await second.exit(), 0);
  await stopped(f);
});
test('stdin EOF without a runtime releases its lock and permits normal restart', async (t) => {
  const f = await fixture(t),
    first = launch(t, f);
  await first.initialize();
  first.child.stdin.end();
  assert.equal(await first.exit(), 0);
  await stopped(f);
  const second = launch(t, f);
  await second.initialize();
  second.child.kill('SIGTERM');
  assert.equal(await second.exit(), 0);
  await stopped(f);
});
test('stdin EOF drains in-flight native input and permits a fresh service', async (t) => {
  const f = await fixture(t),
    first = launch(t, f);
  await first.initialize();
  const pending = first.call('send', {
    session_id: f.id,

    text: '/lifecycle-fixture',
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  first.child.stdin.end();
  const receipt = await pending;
  assert.ok(['started', 'queued', 'handled'].includes(receipt.status), JSON.stringify(receipt));
  assert.equal(receipt.status, 'handled');
  assert.equal(await first.exit(), 0);
  await stopped(f, claim.owner);
  const second = launch(t, f);
  await second.initialize();

  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
  second.child.kill('SIGINT');
  assert.equal(await second.exit(), 0);
  await stopped(f);
});
test('broken stdout drains a pending receipt and cleans up the owned official RPC process', async (t) => {
  const f = await fixture(t),
    server = launch(t, f);
  await server.initialize();
  server.request('tools/call', {
    name: 'send',
    arguments: { session_id: f.id, text: '/lifecycle-fixture' },
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  server.child.stdout.destroy();
  server.request('tools/list', {});
  assert.equal(await server.exit(), 1);
  await stopped(f, claim.owner);
  assert.ok(!server.stderr().includes('Unhandled'));
  const bridge = await new Bridge(f.config).init();
  try {
    assert.equal((await bridge.list({ session_id: f.id })).sessions.length, 1);
    assert.equal(bridge.pool.instances.size, 0);
  } finally {
    await bridge.close();
  }
});
test('repeated stop signals share draining cleanup rather than interrupting the owned RPC receipt', async (t) => {
  const f = await fixture(t),
    server = launch(t, f);
  await server.initialize();
  const pending = server.call('send', {
    session_id: f.id,

    text: '/lifecycle-fixture',
  });
  await until(() => exists(f.marker));
  const claim = await ownClaim(f);
  server.child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 30));
  server.child.kill('SIGINT');
  assert.ok(
    ['started', 'queued', 'handled'].includes((await pending).status),
    'Expected native prompt admission',
  );
  assert.equal(await server.exit(), 0);
  await stopped(f, claim.owner);
});
test('EOF disconnects an actual external Pi TUI without stopping it', async (t) => {
  const f = await fixture(t),
    agentDir = path.join(f.dir, 'agent');
  await fs.mkdir(agentDir);
  await fs.writeFile(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({
      cacheWarming: 'off',
      retry: { enabled: false },
      compaction: { enabled: false },
    }),
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
    path.join(base, 'src/attach-extension.mjs'),
  ];
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  const tui = spawn('script', ['-qefc', args.map(quote).join(' '), '/dev/null'], {
    cwd: f.cwd,
    env: {
      PATH: process.env.PATH,
      HOME: f.dir,
      PI_CODING_AGENT_DIR: agentDir,
      PI_MCP_ATTACH_DIR: f.config.attachmentDir,
      PI_OFFLINE: '1',
      TERM: 'xterm-256color',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  tui.stdout.resume();
  tui.stderr.resume();
  let claim;
  t.after(async () => {
    if (claim && (await ownerAlive(claim.owner))) {
      process.kill(claim.owner.pid, 'SIGTERM');
      await waitOwnerExit(claim.owner);
    }
    tui.stdin.destroy();
    if (tui.exitCode === null) tui.kill('SIGTERM');
  });
  claim = await ownClaim(f);
  assert.equal(claim.kind, 'tui');
  const server = launch(t, f);
  await server.initialize();
  await server.call('read', { session_id: f.id });
  server.child.stdin.end();
  assert.equal(await server.exit(), 0);
  assert.equal(await ownerAlive(claim.owner), true);
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, claim.generation);
});

test('stdio shutdown drains an admitted SDK history read before closing the Bridge', async (t) => {
  const f = await fixture(t),
    preload = path.join(f.dir, 'read-gate.mjs'),
    reached = path.join(f.dir, 'read-reached'),
    release = path.join(f.dir, 'read-release');
  await fs.writeFile(
    preload,
    `import fs from 'node:fs/promises';const open=fs.open;fs.open=async(file,...args)=>{const fd=await open(file,...args);if(file===${JSON.stringify(f.session.file)}){const stream=fd.createReadStream.bind(fd);fd.createReadStream=options=>(async function*(){const input=stream(options);await fs.writeFile(${JSON.stringify(reached)},'yes');while(!await fs.stat(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));yield* input;})();}return fd;};`,
  );
  const server = launch(t, f, ['--import', preload]);
  await server.initialize();
  const reading = server.call('read', { session_id: f.id });
  await until(() => exists(reached));
  server.child.stdin.end();
  try {
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(
      server.child.exitCode,
      null,
      'SDK tool must remain in the same transport drain as per-request tools',
    );
    await fs.writeFile(release, 'go');
    assert.equal((await reading).session_id, f.id);
    assert.equal(await server.exit(), 0);
  } finally {
    await fs.writeFile(release, 'go');
    await reading.catch(() => {});
  }
});

for (const modern of [false, true])
  for (const endInput of [false, true])
    test(
      (modern ? 'modern' : 'SDK') +
        ' stdio batch ' +
        (endInput
          ? 'EOF finishes dispatched work but rejects the next lane mutation'
          : 'keeps both lane mutations while the service remains open'),
      { timeout: 15000 },
      async (t) => {
        const f = await fixture(t),
          trace = path.join(f.dir, 'calls.log');
        await fs.writeFile(
          path.join(f.dir, 'command.mjs'),
          'import fs from "node:fs/promises";export default pi=>pi.registerCommand("lifecycle-fixture",{handler:async(args)=>{await fs.appendFile(' +
            JSON.stringify(trace) +
            ',args+"\\n");await fs.writeFile(' +
            JSON.stringify(f.marker) +
            ',"started");await new Promise(r=>setTimeout(r,300));}});',
        );
        const server = launch(t, f);
        await server.initialize(modern ? MODERN_VERSION : '2024-11-05');
        const result = server.request('tools/call', {
          name: 'batch',
          arguments: {
            operations: ['FIRST', 'SECOND'].map((text) => ({
              op: 'send',
              args: { session_id: f.id, text: '/lifecycle-fixture ' + text },
            })),
          },
          ...(modern
            ? {
                _meta: {
                  [META + 'protocolVersion']: MODERN_VERSION,
                  [META + 'clientCapabilities']: {},
                },
              }
            : {}),
        });
        await until(() => exists(f.marker));
        if (endInput) server.child.stdin.end();
        const response = (await result).result;
        assert.ok(!response.isError, JSON.stringify(response));
        const items = response.structuredContent.results;
        assert.equal(items[0].result.status, 'handled');
        if (endInput) assert.equal(items[1].error.code, 'BRIDGE_CLOSING');
        else assert.equal(items[1].result.status, 'handled');
        assert.deepEqual(
          (await fs.readFile(trace, 'utf8')).trim().split('\n'),
          endInput ? ['FIRST'] : ['FIRST', 'SECOND'],
        );
        if (!endInput) server.child.stdin.end();
        assert.equal(await server.exit(), 0);
      },
    );

test(
  'stdio EOF drains an owner-local release already waiting on an owned shutdown hook',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      shutdown = path.join(f.dir, 'shutdown'),
      release = path.join(f.dir, 'shutdown-go'),
      admitted = path.join(f.dir, 'owner-admitted');
    await fs.writeFile(
      path.join(f.dir, 'command.mjs'),
      'import fs from "node:fs/promises";export default pi=>{pi.registerCommand("lifecycle-fixture",{handler:async()=>{}});pi.on("session_shutdown",async()=>{await fs.writeFile(' +
        JSON.stringify(shutdown) +
        ',"yes");while(!await fs.stat(' +
        JSON.stringify(release) +
        ').then(()=>true,()=>false))await new Promise(r=>setTimeout(r,10));});};',
    );
    const preload = path.join(f.dir, 'owner-observer.mjs');
    await fs.writeFile(
      preload,
      'import fs from "node:fs/promises";import {Bridge} from ' +
        JSON.stringify(new URL('../src/bridge.mjs', import.meta.url).href) +
        ';const release=Bridge.prototype.releaseForLocal;Bridge.prototype.releaseForLocal=async function(...args){const result=release.apply(this,args);await fs.writeFile(' +
        JSON.stringify(admitted) +
        ',"yes");return result;};',
    );
    const server = launch(t, f, ['--import', preload]);
    let pending;
    try {
      await server.initialize();
      await server.call('send', { session_id: f.id, text: '/lifecycle-fixture' });
      const owner = (await ownClaim(f)).owner;
      pending = ownerRequest(f.config, { op: 'release', session_id: f.id }).catch((error) => ({
        reason: error.message,
      }));
      await until(() => exists(admitted));
      await until(() => exists(shutdown));
      server.child.stdin.end();
      await pending;
      assert.equal(await server.exit(), 0);
      assert.equal(await ownerAlive(owner), false);
      const paused = await readClaim(f.config.attachmentDir, f.session);
      assert.equal(paused.owner, null);
      assert.equal(paused.noColdReacquire, true);
    } finally {
      await fs.writeFile(release, 'go');
      server.child.stdin.end();
      await pending;
    }
  },
);
