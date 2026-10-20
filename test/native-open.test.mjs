import { nativeInstallation } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Bridge } from '../src/bridge.mjs';
import { openProfile } from '../src/open.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/attachments.mjs';
import { savedSession } from './fixtures/saved-session.mjs';

const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) {
    if (await fn()) return;
    await delay(20);
  }
  throw new Error('Native open timed out: ' + label);
}

test(
  'fresh TUI launcher auto-joins after native work settles, inherits ordinary configuration and resumes headless after quit',
  { timeout: 25000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-native-open-'),
      cwd = path.join(dir, 'project'),
      agent = path.join(dir, 'agent'),
      native = await nativeInstallation(dir);
    await fs.mkdir(cwd);
    await fs.mkdir(path.join(agent, 'extensions'), { recursive: true });
    const provider = path.resolve('test/fixtures/faux-extension.mjs');
    await fs.writeFile(
      path.join(agent, 'extensions', 'provider.js'),
      `export {default} from ${JSON.stringify(provider)};`,
    );
    const probe = path.join(agent, 'extensions', 'probe.js');
    await fs.writeFile(
      probe,
      `import fs from 'node:fs/promises';const dir=${JSON.stringify(dir)};
    const exists=async file=>fs.stat(file).then(()=>true,()=>false);
    export default pi=>{
      pi.on('session_start',async(event,ctx)=>{
        await fs.writeFile(dir+'/'+(event.reason==='resume'?'resumed.json':'startup-'+process.pid+'.json'),JSON.stringify({
          cli:process.argv[1],pid:process.pid,file:ctx.sessionManager.getSessionFile(),tools:pi.getActiveTools(),entries:ctx.sessionManager.getEntries()}));
      });
      pi.on('agent_before_settle',async()=>{if(process.env.PI_OPEN_FIXTURE_HOLD==='1'){await fs.writeFile(dir+'/settling','yes');while(!await exists(dir+'/continue'))await new Promise(r=>setTimeout(r,10));}});
    };`,
    );
    await fs.writeFile(
      path.join(agent, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'bridge-fixture',
        defaultModel: 'deterministic',
        defaultThinkingLevel: 'off',
        defaultTools: ['read', 'bash'],
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    await fs.writeFile(
      path.join(agent, 'auth.json'),
      JSON.stringify({ 'bridge-fixture': { type: 'api_key', key: 'synthetic-only' } }),
    );
    const config = {
      principal: 'native-open',
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      attachmentDir: path.join(dir, 'ipc'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ id: 'p', path: cwd }],
      grants: [{ folder: cwd, read: true, send: true }],
      piRuntime: { agentDir: agent, inheritEnv: ['PATH', 'PI_OFFLINE', 'PI_OPEN_FIXTURE_HOLD'] },
      piArgs: ['--offline'],
    };
    const configFile = path.join(dir, 'owner.json');
    await fs.writeFile(configFile, JSON.stringify(config));
    const prior = process.env.PI_OPEN_FIXTURE_HOLD,
      priorPath = process.env.PATH;
    process.env.PI_OPEN_FIXTURE_HOLD = '1';
    process.env.PATH = native.PATH;
    const bridge = await new Bridge(config).init(),
      made = await savedSession(bridge, { folder_id: 'p' }),
      session = await bridge.session(made.session_id);
    let tui, owner;
    t.after(async () => {
      await fs.writeFile(path.join(dir, 'continue'), 'yes').catch(() => {});
      if (owner && (await ownerAlive(owner.owner))) {
        process.kill(owner.owner.pid, 'SIGTERM');
        await waitOwnerExit(owner.owner);
      }
      tui?.stdin.destroy();
      if (tui && tui.exitCode === null) tui.kill('SIGTERM');
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
      if (prior === undefined) delete process.env.PI_OPEN_FIXTURE_HOLD;
      else process.env.PI_OPEN_FIXTURE_HOLD = prior;
      process.env.PATH = priorPath;
    });
    assert.equal(
      (await bridge.send({ session_id: session.id, request_id: 'work', text: 'NATIVE_OPEN_WORK' }))
        .status,
      'accepted',
    );
    const rpc = bridge.pool.get(session.id),
      old = structuredClone(rpc.ownerRecord);
    await until(
      () =>
        fs.stat(path.join(dir, 'settling')).then(
          () => true,
          () => false,
        ),
      'owned settling',
    );
    const profile = await openProfile(configFile, session.id, {
      PATH: process.env.PATH,
      HOME: dir,
      TERM: 'xterm-256color',
      LANG: 'C.UTF-8',
      PI_OFFLINE: '1',
    });
    assert.equal(profile.command, native.executable);
    assert.equal(rpc.child.spawnfile, native.executable);
    assert.equal(profile.args.includes('--session'), false);
    tui = spawn(
      'script',
      ['-qefc', [profile.command, ...profile.args].map(quote).join(' '), '/dev/null'],
      { cwd: profile.cwd, env: profile.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    tui.stdout.resume();
    tui.stderr.resume();
    await until(() => bridge.handoffs.has(session.id), 'automatic join');
    assert.equal(await ownerAlive(old.owner), true);
    assert.equal(
      await fs.stat(path.join(dir, 'resumed.json')).then(
        () => true,
        () => false,
      ),
      false,
    );
    await fs.writeFile(path.join(dir, 'continue'), 'yes');
    await until(
      () =>
        fs.stat(path.join(dir, 'resumed.json')).then(
          () => true,
          () => false,
        ),
      'native target resume',
    );
    const resumed = JSON.parse(await fs.readFile(path.join(dir, 'resumed.json'), 'utf8'));
    assert.equal(resumed.file, session.file);
    assert.deepEqual(resumed.tools, ['read', 'bash']);
    assert.ok(resumed.entries.some((entry) => entry.message?.role === 'assistant'));
    assert.equal(rpc.child.exitCode, 0);
    assert.equal(await ownerAlive(old.owner), false);
    owner = await readClaim(config.attachmentDir, session);
    assert.equal(owner.phase, 'ready');
    assert.equal(owner.kind, 'tui');
    assert.equal(resumed.pid, owner.owner.pid);
    assert.equal(await fs.realpath(resumed.cli), native.implementation);
    const initial = JSON.parse(
      await fs.readFile(path.join(dir, 'startup-' + owner.owner.pid + '.json'), 'utf8'),
    );
    assert.notEqual(initial.file, session.file);
    process.kill(owner.owner.pid, 'SIGTERM');
    await waitOwnerExit(owner.owner);
    assert.equal((await readClaim(config.attachmentDir, session)).coldReacquireAfterExit, true);
    const resumedHeadless = await bridge.send({
      session_id: session.id,
      request_id: 'after-quit',
      text: 'HEADLESS_AFTER_NATIVE_QUIT',
    });
    assert.equal(resumedHeadless.status, 'accepted', JSON.stringify(resumedHeadless));
    const next = bridge.pool.get(session.id);
    assert.equal(next.child.spawnfile, native.executable);
    assert.notEqual(next.child.pid, old.owner.pid);
    assert.equal(next.session.file, session.file);
  },
);
