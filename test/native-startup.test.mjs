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
