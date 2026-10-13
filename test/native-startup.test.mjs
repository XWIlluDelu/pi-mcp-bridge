import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {pathToFileURL} from 'node:url';
import {RpcClient,SessionManager} from '@earendil-works/pi-coding-agent';
import {fauxAssistantMessage} from '@earendil-works/pi-ai';
const exec=promisify(execFile),base=path.resolve('.');
async function fixture(t,model={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-native-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const manager=SessionManager.create(cwd,path.join(dir,'sessions'));
  manager.appendMessage({role:'user',content:[{type:'text',text:'SAVED_NATIVE_SEED'}],timestamp:Date.now()});
  manager.appendMessage({...fauxAssistantMessage('Saved native seed response'),...model});
  return {dir,cwd,file:manager.getSessionFile(),id:manager.getSessionId()};
}
test('Bridge launcher without profile uses native HOME/settings/packages/tools and saved selection',{timeout:15000},async t=>{
  const f=await fixture(t,{provider:'native-fixture',model:'native-model'}),agent=path.join(f.dir,'.pi','agent'),pkg=path.join(f.dir,'synthetic-package');await fs.mkdir(agent,{recursive:true});await fs.mkdir(pkg);
  await fs.writeFile(path.join(pkg,'package.json'),JSON.stringify({name:'synthetic-native-config',version:'0.0.0',type:'module',pi:{extensions:['index.mjs']}}));
  await fs.writeFile(path.join(pkg,'index.mjs'),`import {fauxProvider} from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-ai'))};export default pi=>{
    const faux=fauxProvider({provider:'native-fixture',models:[{id:'native-model',name:'Synthetic native default',reasoning:true},{id:'saved-model',name:'Synthetic saved selection',reasoning:true}]});
    pi.registerProvider(faux.provider);pi.on('session_start',()=>pi.appendEntry('native-package',{tools:pi.getActiveTools(),env:process.env.NATIVE_FIXTURE_VALUE}));
  };`);
  await fs.writeFile(path.join(agent,'settings.json'),JSON.stringify({packages:[pkg],defaultProvider:'native-fixture',defaultModel:'native-model',defaultThinkingLevel:'high',defaultTools:['read','bash'],cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
  // Configured auth keeps native model selection stable across Pi's async provider refresh.
  // This is synthetic; the faux provider never contacts a service.
  await fs.writeFile(path.join(agent,'auth.json'),JSON.stringify({'native-fixture':{type:'api_key',key:'synthetic-native-fixture-only'}}));
  const script=`
    import {PiRpc} from ${JSON.stringify(pathToFileURL(path.join(base,'src/rpc.mjs')).href)};
    const config={stateDir:${JSON.stringify(path.join(f.dir,'state'))}},session={file:${JSON.stringify(f.file)},cwd:${JSON.stringify(f.cwd)},header:{id:${JSON.stringify(f.id)}}};
    let rpc=await new PiRpc(config,session).start();
    try{
      const state=await rpc.state(),entries=await rpc.entries(),shell=await rpc.command({type:'bash',command:'pwd'});
      // Select a different saved model without overwriting the native defaults.
      await rpc.command({type:'set_model',provider:'native-fixture',modelId:'saved-model'});
      await rpc.command({type:'set_thinking_level',level:'medium'});await rpc.stop();
      rpc=await new PiRpc(config,session).start();const restored=await rpc.state();
      console.log(JSON.stringify({model:state.model.id,thinking:state.thinkingLevel,probe:entries.entries.find(e=>e.customType==='native-package').data,shell:shell.output.trim(),restoredModel:restored.model.id,restoredThinking:restored.thinkingLevel}));
    }finally{await rpc.stop();}
  `;
  const result=await exec(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1',NATIVE_FIXTURE_VALUE:'inherited'},timeout:10000});
  assert.deepEqual(JSON.parse(result.stdout),{model:'native-model',thinking:'high',probe:{tools:['read','bash'],env:'inherited'},shell:f.cwd,restoredModel:'saved-model',restoredThinking:'medium'});
  const settings=JSON.parse(await fs.readFile(path.join(agent,'settings.json'),'utf8'));
  assert.equal(settings.defaultModel,'native-model');assert.equal(settings.defaultThinkingLevel,'high');
});
test('installed companion leaves Bridge-owned claims intact and registers ordinary RPC',{timeout:20000},async t=>{
  const f=await fixture(t,{provider:'bridge-fixture',model:'deterministic'}),agent=path.join(f.dir,'profile'),ipc=path.join(f.dir,'ipc');
  await fs.mkdir(path.join(agent,'extensions'),{recursive:true});
  await fs.writeFile(path.join(agent,'settings.json'),JSON.stringify({defaultProvider:'bridge-fixture',defaultModel:'deterministic',cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
  await fs.writeFile(path.join(agent,'auth.json'),JSON.stringify({'bridge-fixture':{type:'api_key',key:'synthetic-profile-fixture-only'}}));
  await fs.writeFile(path.join(agent,'extensions','companion.js'),
    `export {default} from ${JSON.stringify(pathToFileURL(path.join(base,'src/attach-extension.mjs')).href)};`);
  await fs.writeFile(path.join(agent,'extensions','provider.js'),
    `export {default} from ${JSON.stringify(pathToFileURL(path.join(base,'research/faux-extension.mjs')).href)};`);
  await fs.writeFile(path.join(agent,'extensions','probe.js'),
    "export default pi=>pi.on('session_start',()=>pi.appendEntry('profile-probe',{tools:pi.getActiveTools()}));");
  const script=`
    import {RuntimePool} from ${JSON.stringify(pathToFileURL(path.join(base,'src/rpc.mjs')).href)};
    import {readClaim} from ${JSON.stringify(pathToFileURL(path.join(base,'src/attachments.mjs')).href)};
    import {RpcClient} from ${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))};
    const target={id:'profile-fixture',file:${JSON.stringify(f.file)},cwd:${JSON.stringify(f.cwd)},header:{id:${JSON.stringify(f.id)}}},dir=${JSON.stringify(ipc)};
    const pool=new RuntimePool({stateDir:${JSON.stringify(path.join(f.dir,'state'))},attachmentDir:dir});
    let rpc;
    let owned,profile,disposition,settlement;
    try{
      rpc=await pool.resolve(target);owned=await readClaim(dir,target);
      const snapshot=await rpc.entries();profile=snapshot.entries.find(e=>e.customType==='profile-probe').data;
      if(owned.generation!==rpc.ownerRecord.generation)throw Error('CLAIM_REPLACED');
      ({disposition}=await rpc.command({type:'prompt',message:'PROFILE_STARTUP_INPUT'}));
      while(rpc.settlement.sequence===0)await new Promise(resolve=>setTimeout(resolve,10));
      settlement=rpc.settlement.sequence;
      if(await pool.forRead(target)!==rpc)throw Error('RUNTIME_REPLACED');
    }finally{await pool.close();}
    const local=new RpcClient({cliPath:${JSON.stringify(path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'))},cwd:target.cwd,args:['--session',target.file]});
    try{
      await local.start();const state=await local.getState(),external=await readClaim(dir,target);
      console.log(JSON.stringify({ownedKind:owned.kind,ownedPhase:owned.phase,disposition,settlement,tools:profile.tools,externalKind:external.kind,externalPhase:external.phase,sameSession:state.sessionId===target.header.id}));
    }finally{await local.stop();}
  `;
  const result=await exec(process.execPath,['--input-type=module','-e',script],{env:{PATH:process.env.PATH,HOME:f.dir,PI_CODING_AGENT_DIR:agent,PI_MCP_ATTACH_DIR:ipc,PI_OFFLINE:'1'},timeout:15000});
  const observed=JSON.parse(result.stdout);
  assert.equal(observed.ownedKind,'rpc');assert.equal(observed.ownedPhase,'ready');
  assert.equal(observed.disposition,'started');assert.equal(observed.settlement,1);
  assert.equal(observed.externalKind,'extension');assert.equal(observed.externalPhase,'ready');assert.equal(observed.sameSession,true);
  for(const tool of ['read','bash','edit','write'])assert.ok(observed.tools.includes(tool));
});
test('initial startup migrates before extension factory, but before-switch hook sees target before open',{timeout:15000},async t=>{
  const f=await fixture(t),initial=f.file,target=path.join(path.dirname(initial),'legacy-target.jsonl'),evidence=path.join(f.dir,'order.json'),extension=path.join(f.dir,'order.mjs'),agent=path.join(f.dir,'agent');
  await fs.mkdir(agent);
  const lines=(await fs.readFile(initial,'utf8')).trim().split('\n');const header=JSON.parse(lines[0]);header.version=2;
  await fs.writeFile(initial,JSON.stringify(header)+'\n'+lines.slice(1).join('\n')+'\n');
  await fs.writeFile(target,JSON.stringify({...header,id:'legacy-target-fixture'})+'\n'+lines.slice(1).join('\n')+'\n');
  await fs.writeFile(extension,`import fs from 'node:fs/promises';const version=async file=>JSON.parse((await fs.readFile(file,'utf8')).split('\\n')[0]).version;
    export default async pi=>{if(!await fs.stat(${JSON.stringify(evidence)}).then(()=>true,()=>false))await fs.writeFile(${JSON.stringify(evidence)},JSON.stringify({factoryVersion:await version(${JSON.stringify(initial)})}));
      pi.on('session_before_switch',async event=>{const data=JSON.parse(await fs.readFile(${JSON.stringify(evidence)},'utf8'));data.reason=event.reason;data.beforeSwitchVersion=await version(event.targetSessionFile);await fs.writeFile(${JSON.stringify(evidence)},JSON.stringify(data));});
    };`);
  const env=Object.fromEntries(Object.keys(process.env).map(key=>[key,undefined]));
  Object.assign(env,{PATH:process.env.PATH,HOME:f.dir,PI_CODING_AGENT_DIR:agent,PI_OFFLINE:'1'});
  const client=new RpcClient({cliPath:path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/cli.js'),cwd:f.cwd,env,
    args:['--session',initial,'-e',extension,'-e',path.join(base,'research/faux-extension.mjs')],provider:'bridge-fixture',model:'deterministic'});
  t.after(()=>client.stop());await client.start();await client.getState();
  assert.equal(JSON.parse(await fs.readFile(evidence,'utf8')).factoryVersion,3);
  assert.equal(JSON.parse((await fs.readFile(target,'utf8')).split('\n')[0]).version,2);
  await client.switchSession(target);
  assert.deepEqual(JSON.parse(await fs.readFile(evidence,'utf8')),{factoryVersion:3,reason:'resume',beforeSwitchVersion:2});
  assert.equal(JSON.parse((await fs.readFile(target,'utf8')).split('\n')[0]).version,3);
  assert.equal((await client.getState()).sessionId,'legacy-target-fixture');
});
