import { sdkEntry } from './fixtures/pi.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeInstallation, isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';

const exec = promisify(execFile);
const moduleUrl = (file) => new URL('../' + file, import.meta.url).href;

for (const persistent of [false, true])
  test(`create retains published identity after ${persistent ? 'persistent' : 'one-time'} temporary-link cleanup failure`, async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-create-publication-'),
      root = path.join(dir, 'sessions'),
      config = {
        ...isolatedRuntime(dir),
        stateDir: path.join(dir, 'state'),
        sessionRoots: [root],
        folders: [{ path: dir }],
        defaults: { ...denyAllPermissions(), create: true },
      };
    const bridge = await new Bridge(config, () =>
      assert.fail('No writer after publication failure'),
    ).init();
    t.after(async () => {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    const unlink = fs.unlink;
    let attempts = 0;
    const failure = t.mock.method(fs, 'unlink', async (file) => {
      if (
        file.startsWith(root + path.sep) &&
        file.endsWith('.pending') &&
        (++attempts === 1 || persistent)
      )
        throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
      return unlink(file);
    });
    const result = await bridge.create({
      project: dir,
      ...(persistent ? { text: 'NEVER_DISPATCH' } : {}),
    });
    assert.equal(result.created, true, JSON.stringify(result));
    assert.equal(result.status, 'unknown');
    if (persistent) assert.equal(result.send.status, 'unknown');
    else {
      assert.equal(result.send, undefined);
      assert.equal(typeof result.reason, 'string');
      assert.equal(result.submission_id, undefined);
    }
    assert.match(result.session_id, /^ps_/);
    const files = await fs.readdir(root);
    failure.mock.restore();
    for (const file of files) if (file.endsWith('.pending')) await fs.unlink(path.join(root, file));
    assert.ok((await bridge.session(result.session_id)).file.endsWith('.jsonl'));
  });

// Each scenario has its own HOME, environment, projects and native installation.
// The fake Bridge writer records only a user entry; the real CLI and Bridge RPC
// only resume, inspect and exit. No production data, credentials or model rounds.
const script = `
import fs from 'node:fs/promises';
import path from 'node:path';
import {Bridge} from ${JSON.stringify(moduleUrl('src/bridge.mjs'))};
import {launchProfile} from ${JSON.stringify(moduleUrl('src/rpc.mjs'))};
import {denyAllPermissions} from ${JSON.stringify(new URL('./fixtures/permissions.mjs', import.meta.url).href)};
import {SessionManager, RpcClient} from ${JSON.stringify(sdkEntry)};
const scenario=JSON.parse(process.argv[1]), home=process.env.HOME, project=path.join(home,'project');
await fs.mkdir(project);
const nativeAgent=path.join(home,'.pi','agent'), agent=scenario.agentOverride?path.join(home,'profile'):nativeAgent;
await fs.mkdir(agent,{recursive:true});
const settings={sessionDir:scenario.globalDir,cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}};
const settingsFile=path.join(agent,'settings.json');
await fs.writeFile(settingsFile,JSON.stringify(settings));
await fs.chmod(settingsFile,0o644);
if(scenario.projectDir){await fs.mkdir(path.join(project,'.pi'));await fs.writeFile(path.join(project,'.pi','settings.json'),JSON.stringify({sessionDir:scenario.projectDir}));}
const roots=[path.join(home,'first-root'), scenario.root ?? path.join(agent,'sessions')];
if(scenario.unsafe){await fs.mkdir(roots[1],{recursive:true,mode:0o700});await fs.mkdir(scenario.globalDir);await fs.chmod(scenario.globalDir,0o777);await fs.chmod(home,0o755);await fs.chmod(roots[1],0o755);}
const config={stateDir:path.join(home,'state'),sessionRoots:roots,folders:[{path:project}],defaults:{...denyAllPermissions(),create:true,list:true,read:true,send:true},piArgs:['--offline','--no-extensions','--no-context-files',...(scenario.cliDir?['--session-dir',scenario.cliDir]:[])],...(scenario.agentOverride?{piRuntime:{agentDir:agent}}:{})};
let starts=0, bridge;
const factory = async session => ({
  alive: true,
  state: async () => ({ isIdle: true }),
  idleSnapshot: async () => ({ state: { isIdle: true }, status: 'idle' }),
  hasUnsettledWork: () => false,
  stop: async () => {},
  submitPrompt: async input => {
    starts++;
    const manager = SessionManager.open(session.file);
    manager.appendMessage({ role: 'user', content: [{ type: 'text', text: input.text }], timestamp: Date.now() });
    return { status: 'started' };
  },
});
try{
  bridge=await new Bridge(config,factory).init();
  const args={project,text:'SYNTHETIC_CREATE_INPUT'};
  const result=await bridge.create(args);
  const out={result,starts,first:await fs.readdir(roots[0]),settingsMode:(await fs.stat(settingsFile)).mode&0o777};
  if(result.status==='started'){
    const session=await bridge.session(result.session_id);
    out.file=session.file;
    out.settings=JSON.parse(await fs.readFile(settingsFile,'utf8'));
    if(scenario.reopen){
      await bridge.close();bridge=null;
      const env=launchProfile(config).env;
      const client=new RpcClient({cliPath:scenario.cli,cwd:project,env:Object.assign(Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined])),env),args:['--continue',...config.piArgs]});
      try{await client.start();out.continued=(await client.getState()).sessionId;}finally{await client.stop();}
      bridge=await new Bridge(config).init();
      const rediscovered=await bridge.session(result.session_id);
      out.rediscovered=rediscovered.file;
      out.nativeId=session.header.id;
      await bridge.pool.resolve(rediscovered);
      const rpc=bridge.pool.get(result.session_id);
      out.reconnected=(await rpc.state()).sessionId;
      await rpc.gracefulExit();
    }
  }else{
    out.destinationFiles=await fs.readdir(scenario.globalDir);
    out.destinationMode=(await fs.stat(scenario.globalDir)).mode&0o777;
  }
  console.log(JSON.stringify(out));
}finally{await bridge?.close();}
`;

for (const scenario of [
  { name: 'native HOME default', reopen: true },
  { name: 'explicit agentDir', agentOverride: true },
  { name: 'global settings', globalDir: 'selected' },
  { name: 'project settings override global', globalDir: 'global', projectDir: 'selected' },
  {
    name: 'environment overrides settings',
    globalDir: 'global',
    projectDir: 'project-store',
    envDir: 'selected',
  },
  {
    name: 'CLI overrides environment and settings',
    globalDir: 'global',
    projectDir: 'project-store',
    envDir: 'env-store',
    cliDir: 'selected',
  },
  {
    name: 'an out-of-root destination',
    globalDir: 'outside',
    denied: 'NATIVE_SESSION_OUTSIDE_ROOTS',
  },
  {
    name: 'an unsafe existing destination',
    globalDir: 'selected/unsafe',
    unsafe: true,
    denied: 'UNSAFE_NATIVE_SESSION_STORAGE',
  },
]) {
  test(
    scenario.denied
      ? 'create rejects ' + scenario.name + ' without prompt dispatch or chmod'
      : 'create follows ' +
          scenario.name +
          (scenario.reopen ? ', native continue and Bridge RPC reconnect' : ''),
    { timeout: 15000 },
    async (t) => {
      const dir = await fs.mkdtemp('/tmp/pi-native-create-');
      t.after(() => fs.rm(dir, { recursive: true, force: true }));
      const native = await nativeInstallation(dir);
      const selected = path.join(dir, 'selected');
      const data = {
        ...scenario,
        cli: native.implementation,
        ...(scenario.globalDir
          ? { globalDir: path.join(dir, scenario.globalDir), root: selected }
          : {}),
        ...(scenario.projectDir ? { projectDir: path.join(dir, scenario.projectDir) } : {}),
        ...(scenario.cliDir ? { cliDir: selected } : {}),
      };
      const { stdout } = await exec(
        process.execPath,
        ['--input-type=module', '-e', script, JSON.stringify(data)],
        {
          env: {
            HOME: dir,
            PATH: native.PATH,
            PI_OFFLINE: '1',
            ...(scenario.envDir
              ? { PI_CODING_AGENT_SESSION_DIR: path.join(dir, scenario.envDir) }
              : {}),
          },
          timeout: 12000,
        },
      );
      const out = JSON.parse(stdout);
      if (scenario.denied) {
        assert.equal(out.result.status, 'rejected', stdout);
        assert.equal(out.result.reason, scenario.denied);
        assert.equal(out.starts, 0);
        assert.deepEqual(out.first, []);
        assert.deepEqual(out.destinationFiles, []);
        assert.equal(out.settingsMode, 0o644);
        if (scenario.unsafe) assert.equal(out.destinationMode, 0o777);
        return;
      }
      assert.equal(out.result.status, 'started', stdout);
      assert.equal(out.result.created, true);
      assert.equal(out.starts, 1);
      assert.deepEqual(out.first, []);
      if (scenario.reopen) {
        assert.equal(out.file, out.rediscovered);
        assert.equal(out.continued, out.nativeId);
        assert.equal(out.reconnected, out.nativeId);
      }
      assert.equal(out.settingsMode, 0o644);
      assert.equal(out.settings.sessionDir, data.globalDir);
      assert.ok(
        out.file.startsWith(
          scenario.globalDir
            ? selected + path.sep
            : path.join(dir, scenario.agentOverride ? 'profile' : '.pi/agent', 'sessions') +
                path.sep,
        ),
      );
    },
  );
}
