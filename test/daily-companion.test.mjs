import { aiEntry } from './fixtures/pi.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RpcClient } from './fixtures/pi.mjs';
import { Bridge } from '../src/bridge.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(20);
  }
  throw Error('DAILY_COMPANION_TIMEOUT');
}
const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

for (const mode of ['tui', 'rpc'])
  test(
    'daily ' +
      mode +
      ' loads settings companion before first persistence and survives reload/replacement',
    { timeout: 30000 },
    async (t) => {
      const dir = await fs.mkdtemp('/tmp/pi-daily-'),
        cwd = path.join(dir, 'project'),
        agent = path.join(dir, 'agent');
      const ownerFile = path.join(dir, '.config/pi-mcp-bridge/owner.json'),
        metaFile = path.join(dir, 'native.json');
      const root = path.join(dir, 'sessions'),
        outside = path.join(dir, 'outside', 'outside.jsonl');
      await Promise.all(
        [cwd, agent, root, path.dirname(outside), path.dirname(ownerFile)].map((p) =>
          fs.mkdir(p, { recursive: true, mode: 0o700 }),
        ),
      );
      const config = {
        stateDir: path.join(dir, 'state'),
        attachmentDir: path.join(dir, 'ipc'),
        sessionRoots: [root],
        folders: [{ path: cwd }],
        defaults: denyAllPermissions(),
        grants: [{ folder: cwd, list: true, read: true, send: true }],
      };
      await fs.writeFile(ownerFile, JSON.stringify(config), { mode: 0o600 });
      await fs.writeFile(
        outside,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: '11111111-1111-4111-8111-111111111111',
          timestamp: new Date().toISOString(),
          cwd,
        }) + '\n',
      );
      const probe = path.join(dir, 'probe.mjs'),
        companion = await fs.realpath('src/attach-extension.mjs');
      await fs.writeFile(
        probe,
        `import fs from 'node:fs/promises';
import {fauxProvider} from ${JSON.stringify(aiEntry)};
export default pi=>{
 pi.registerProvider(fauxProvider({provider:'selection-fixture',models:[{id:'other',reasoning:true,input:['text']},{id:'next',reasoning:true,input:['text']}]}).provider);
 pi.on('session_start',async(event,ctx)=>{await fs.writeFile(${JSON.stringify(metaFile)},JSON.stringify({
  pid:process.pid,file:ctx.sessionManager.getSessionFile(),header:ctx.sessionManager.getHeader(),
  joinCommands:pi.getCommands().filter(c=>c.name==='bridge-join').length
 }));});
 pi.registerCommand('fixture-reload',{handler:async(_,ctx)=>ctx.reload()});
 pi.registerCommand('fixture-switch-outside',{handler:async(_,ctx)=>ctx.switchSession(${JSON.stringify(outside)})});
};`,
      );
      await fs.writeFile(
        path.join(agent, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'bridge-fixture',
          defaultModel: 'deterministic',
          defaultThinkingLevel: 'low',
          modelThinkingLevels: { 'selection-fixture/next': 'medium' },
          compaction: { enabled: false },
          retry: { enabled: false },
          extensions: [path.resolve('test/fixtures/faux-extension.mjs'), companion, probe],
        }),
      );
      // Keep synthetic authentication explicit, as in native-open. The test
      // exercises registration/lifecycle, not background provider-auth refresh.
      await fs.writeFile(
        path.join(agent, 'auth.json'),
        JSON.stringify({ 'bridge-fixture': { type: 'api_key', key: 'synthetic-only' } }),
      );
      const env = {
        PATH: process.env.PATH,
        HOME: dir,
        PI_CODING_AGENT_DIR: agent,
        PI_OFFLINE: '1',
        TERM: 'xterm-256color',
        LANG: 'C.UTF-8',
      };
      // The ordinary TUI needs no Bridge-specific environment. The explicit host
      // profile and duplicate -e entry must also stay single-owner on the RPC path.
      if (mode === 'rpc')
        Object.assign(env, {
          PI_MCP_OWNER_CONFIG: ownerFile,
          PI_MCP_ATTACH_DIR: config.attachmentDir,
        });
      const args = [
        '--session-dir',
        root,
        '--offline',
        '--no-context-files',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        ...(mode === 'rpc' ? ['-e', companion] : []),
      ];
      let child, local, identity, bridge;
      t.after(async () => {
        if (local) await local.stop();
        if (child) {
          if (identity && (await ownerAlive(identity))) {
            process.kill(identity.pid, 'SIGTERM');
            await waitOwnerExit(identity);
          }
          child.stdin.destroy();
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
          await until(() => child.exitCode !== null || child.signalCode !== null);
        }
        await bridge?.close();
        await fs.rm(dir, { recursive: true, force: true });
      });
      if (mode === 'rpc') {
        const clear = Object.fromEntries(Object.keys(process.env).map((k) => [k, undefined]));
        local = new RpcClient({ cliPath: nativePiCli, cwd, env: { ...clear, ...env }, args });
        await local.start();
      } else {
        child = spawn(
          'script',
          ['-qefc', [process.execPath, nativePiCli, ...args].map(quote).join(' '), '/dev/null'],
          { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] },
        );
        child.stdout.resume();
        child.stderr.resume();
      }
      const meta = await until(async () =>
        exists(metaFile).then(async (yes) =>
          yes ? JSON.parse(await fs.readFile(metaFile, 'utf8')) : null,
        ),
      );
      const session = { file: meta.file, header: meta.header };
      let claim = await readClaim(config.attachmentDir, session);
      identity = claim.owner;
      assert.equal(identity.pid, meta.pid);
      assert.equal(meta.joinCommands, 1);
      assert.equal(claim.phase, 'ready');
      assert.equal(await exists(meta.file), false);
      const sockets = async () =>
        (await fs.readdir(config.attachmentDir)).filter(
          (f) => f.startsWith(meta.pid + '-') && f.endsWith('.sock'),
        );
      assert.deepEqual(await sockets(), [path.basename(claim.socket)]);
      const send = async (text) => {
        if (local) await local.prompt(text);
        else child.stdin.write(text + '\r');
      };
      await send('LOCAL_FIRST');
      await until(async () =>
        exists(meta.file).then(
          async (yes) =>
            yes && (await fs.readFile(meta.file, 'utf8')).includes('Synthetic response'),
        ),
      );
      bridge = await new Bridge(config, async () => {
        throw Error('UNEXPECTED_SECOND_WRITER');
      }).init();
      const saved = await until(async () =>
        (await bridge.sessions()).find((s) => s.file === meta.file),
      );
      const status = (await bridge.list({ session_id: saved.id })).sessions[0].status;
      assert.equal(claim.kind, mode === 'tui' ? 'tui' : 'extension');
      assert.deepEqual(status.capabilities, { send: true, command: false, stop: false });
      const defaultsBeforeSelection = await fs.readFile(path.join(agent, 'settings.json'), 'utf8');
      const selected = await bridge.set_model({
        session_id: saved.id,
        model: { provider: 'selection-fixture', id: 'other' },
        thinking_level: 'high',
      });
      assert.deepEqual(selected, {
        model: { provider: 'selection-fixture', id: 'other' },
        thinking_level: 'high',
      });
      assert.deepEqual(
        await bridge.set_model({
          session_id: saved.id,
          model: { provider: 'selection-fixture', id: 'next' },
        }),
        { model: { provider: 'selection-fixture', id: 'next' }, thinking_level: 'high' },
      );
      assert.deepEqual(
        await bridge.set_model({
          session_id: saved.id,
          model: { provider: 'bridge-fixture', id: 'deterministic' },
        }),
        { model: { provider: 'bridge-fixture', id: 'deterministic' }, thinking_level: 'off' },
      );
      assert.equal(
        await fs.readFile(path.join(agent, 'settings.json'), 'utf8'),
        defaultsBeforeSelection,
      );
      assert.equal((await readClaim(config.attachmentDir, session)).owner.pid, meta.pid);
      assert.equal(
        (await fs.readFile(meta.file, 'utf8'))
          .trim()
          .split('\n')
          .map(JSON.parse)
          .filter((e) => e.message?.role === 'user').length,
        1,
      );
      await bridge.send({ session_id: saved.id, text: 'REMOTE_DAILY' });
      await until(async () => {
        const entries = (await fs.readFile(meta.file, 'utf8')).trim().split('\n').map(JSON.parse);
        return entries.some(
          ({ message }) =>
            message?.role === 'user' &&
            Array.isArray(message.content) &&
            message.content.some((block) => block.type === 'text' && block.text === 'REMOTE_DAILY'),
        );
      });
      await until(async () => !(await bridge.pool.get(saved.id).state()).isStreaming);
      const before = claim;
      await send('/fixture-reload');
      claim = await until(async () => {
        const after = await readClaim(config.attachmentDir, session);
        return after?.phase === 'ready' && after.generation !== before.generation ? after : null;
      });
      for (const key of ['pid', 'start', 'boot']) assert.equal(claim.owner[key], before.owner[key]);
      assert.equal(await exists(before.socket), false);
      assert.deepEqual(await sockets(), [path.basename(claim.socket)]);
      await bridge.send({ session_id: saved.id, text: 'AFTER_RELOAD' });
      await until(
        async () =>
          (await fs.readFile(meta.file, 'utf8')).includes('AFTER_RELOAD') &&
          !(await bridge.pool.get(saved.id).state()).isStreaming,
      );
      const entries = (await fs.readFile(meta.file, 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s));
      for (const text of ['LOCAL_FIRST', 'REMOTE_DAILY', 'AFTER_RELOAD'])
        assert.equal(
          entries.filter(
            (e) => e.message?.role === 'user' && JSON.stringify(e.message.content).includes(text),
          ).length,
          1,
        );
      await send('/fixture-switch-outside');
      await until(async () => JSON.parse(await fs.readFile(metaFile, 'utf8')).file === outside);
      assert.equal(await readClaim(config.attachmentDir, session), null);
      assert.equal(
        (await fs.readdir(config.attachmentDir)).filter((f) => f.endsWith('.owner.json')).length,
        0,
      );
      assert.deepEqual(await sockets(), []);
      assert.equal(await ownerAlive(identity), true);
    },
  );
