import { sdkEntry } from './fixtures/pi.mjs';
import { nativePiCli, nativeInstallation } from './fixtures/isolated-runtime.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { SessionManager } from './fixtures/pi.mjs';
import { fauxAssistantMessage } from './fixtures/pi.mjs';
const exec = promisify(execFile),
  base = path.resolve('.');
async function fixture(t, model = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-')),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const manager = SessionManager.create(cwd, path.join(dir, 'sessions'));
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'SAVED_NATIVE_SEED' }],
    timestamp: Date.now(),
  });
  manager.appendMessage({ ...fauxAssistantMessage('Saved native seed response'), ...model });
  return {
    dir,
    cwd,
    file: manager.getSessionFile(),
    id: manager.getSessionId(),
    native: await nativeInstallation(dir),
  };
}

test(
  'installed companion leaves Bridge-owned claims intact and registers ordinary RPC',
  { timeout: 20000 },
  async (t) => {
    const f = await fixture(t, { provider: 'bridge-fixture', model: 'deterministic' }),
      agent = path.join(f.dir, 'profile'),
      ipc = path.join(f.dir, 'ipc');
    await fs.mkdir(path.join(agent, 'extensions'), { recursive: true });
    await fs.writeFile(
      path.join(agent, 'settings.json'),
      JSON.stringify({
        defaultProvider: 'bridge-fixture',
        defaultModel: 'deterministic',
        cacheWarming: 'off',
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    await fs.writeFile(
      path.join(agent, 'auth.json'),
      JSON.stringify({
        'bridge-fixture': { type: 'api_key', key: 'synthetic-profile-fixture-only' },
      }),
    );
    await fs.writeFile(
      path.join(agent, 'extensions', 'companion.js'),
      `export {default} from ${JSON.stringify(pathToFileURL(path.join(base, 'src/attach-extension.mjs')).href)};`,
    );
    await fs.writeFile(
      path.join(agent, 'extensions', 'provider.js'),
      `export {default} from ${JSON.stringify(pathToFileURL(path.join(base, 'test/fixtures/faux-extension.mjs')).href)};`,
    );
    await fs.writeFile(
      path.join(agent, 'extensions', 'probe.js'),
      "export default pi=>pi.on('session_start',()=>pi.appendEntry('profile-probe',{tools:pi.getActiveTools()}));",
    );
    const script = `
    import {RuntimePool} from ${JSON.stringify(pathToFileURL(path.join(base, 'src/rpc.mjs')).href)};
    import {readClaim} from ${JSON.stringify(pathToFileURL(path.join(base, 'src/attachments.mjs')).href)};
    import {RpcClient} from ${JSON.stringify(sdkEntry)};
    const target={id:'profile-fixture',file:${JSON.stringify(f.file)},cwd:${JSON.stringify(f.cwd)},header:{id:${JSON.stringify(f.id)}}},dir=${JSON.stringify(ipc)};
    const pool=new RuntimePool({stateDir:${JSON.stringify(path.join(f.dir, 'state'))},attachmentDir:dir});
    let rpc;
    let owned,profile,disposition,settlement;
    try{
      rpc=await pool.resolve(target);owned=await readClaim(dir,target);
      const snapshot=await rpc.entries();profile=snapshot.entries.find(e=>e.customType==='profile-probe').data;
      if(owned.generation!==rpc.ownerRecord.generation)throw Error('CLAIM_REPLACED');
      ({disposition}=await rpc.command({type:'prompt',message:'PROFILE_STARTUP_INPUT'}));
      while(rpc.settlementSequence===0)await new Promise(resolve=>setTimeout(resolve,10));
      settlement=rpc.settlementSequence;
      if(await pool.forRead(target)!==rpc)throw Error('RUNTIME_REPLACED');
      pool.config.piExecutable='/nonexistent/native-pi-fixture';
      if(await pool.resolve(target)!==rpc)throw Error('EXISTING_WRITER_NOT_REUSED');
    }finally{await pool.close();}
    const local=new RpcClient({cliPath:${JSON.stringify(nativePiCli)},cwd:target.cwd,args:['--session',target.file]});
    try{
      await local.start();const state=await local.getState(),external=await readClaim(dir,target);
      console.log(JSON.stringify({ownedKind:owned.kind,ownedPhase:owned.phase,disposition,settlement,tools:profile.tools,externalKind:external.kind,externalPhase:external.phase,sameSession:state.sessionId===target.header.id}));
    }finally{await local.stop();}
  `;
    const result = await exec(process.execPath, ['--input-type=module', '-e', script], {
      env: {
        PATH: f.native.PATH,
        HOME: f.dir,
        PI_CODING_AGENT_DIR: agent,
        PI_MCP_ATTACH_DIR: ipc,
        PI_OFFLINE: '1',
      },
      timeout: 15000,
    });
    const observed = JSON.parse(result.stdout);
    assert.equal(observed.ownedKind, 'rpc');
    assert.equal(observed.ownedPhase, 'ready');
    assert.equal(observed.disposition, 'started');
    assert.equal(observed.settlement, 1);
    assert.equal(observed.externalKind, 'extension');
    assert.equal(observed.externalPhase, 'ready');
    assert.equal(observed.sameSession, true);
    for (const tool of ['read', 'bash', 'edit', 'write']) assert.ok(observed.tools.includes(tool));
  },
);
