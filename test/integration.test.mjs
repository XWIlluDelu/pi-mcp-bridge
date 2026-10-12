import { loadSavedSession } from '../src/data.mjs';
import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function configFixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-mcp-integration-'));
  const cwd=path.join(dir,'project');await fs.mkdir(cwd);
  const config={...isolatedRuntime(dir),principal:'isolated-test',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
  t.after(()=>fs.rm(dir,{recursive:true,force:true})); return {config,dir,cwd};
}
function loader() {return {
  getExtensions:()=>({extensions:[],errors:[],runtime:createExtensionRuntime()}),getSkills:()=>({skills:[],diagnostics:[]}),getPrompts:()=>({prompts:[],diagnostics:[]}),getThemes:()=>({themes:[],diagnostics:[]}),getAgentsFiles:()=>({agentsFiles:[]}),getSystemPrompt:()=> 'Synthetic test.',getSystemPromptSource:()=>undefined,getAppendSystemPrompt:()=>[],getAppendSystemPromptSources:()=>[],extendResources:()=>{},reload:async()=>{},
};}

test('official Pi CLI RPC resumes a durable empty session without credentials',async t=>{
  const f=await configFixture(t); const bridge=await new Bridge(f.config).init();
  let runtime;
  try {
    const made=await bridge.create({folder_id:'project',request_id:'empty'});
    const session=await bridge.session(made.session_id);
    runtime=await new PiRpc(f.config,session).start();
    assert.equal((await runtime.state()).isStreaming,false);
    const data=await runtime.entries();assert.ok(Array.isArray(data.entries));
    const persisted=(await fs.readFile(session.file,'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(persisted.filter(e=>e.type==='message' && ['user','assistant'].includes(e.message.role)).length,0);
    // A prompt is deliberately not sent: this test only verifies real RPC startup/resume.
  } finally {await runtime?.stop();await bridge.close();}
});

test('official Pi extension session switch is stopped and cannot be read under old identity',async t=>{
  const f=await configFixture(t);
  const extension=path.join(f.dir,'switch.mjs');
  await fs.writeFile(extension,`export default function(pi) { pi.registerCommand('switch-fixture', {handler: async (_args, ctx) => { await ctx.newSession(); }}); }`);
  f.config.piArgs=['--offline','-e',extension];
  const bridge=await new Bridge(f.config).init();let runtime;
  try {
    const made=await bridge.create({folder_id:'project',request_id:'switch-create'});
    runtime=await bridge.pool.resolve(await bridge.session(made.session_id));
    const result=await bridge.send({session_id:made.session_id,request_id:'switch',text:'/switch-fixture'});
    assert.equal(result.status,'unknown');assert.equal(result.reason,'RUNTIME_SESSION_CHANGED');
    assert.equal(runtime.exited,true);
    const original=await bridge.read({session_id:made.session_id});
    assert.equal(original.items.length,0);
  } finally {await runtime?.stop();await bridge.close();}
});

test('real Pi SDK with faux provider sends, persists, reads and resumes (no real model)',async t=>{
  const f=await configFixture(t);let created=0,settled=0;
  const faux=fauxProvider({provider:'bridge-fixture'});
  faux.setResponses([fauxAssistantMessage('first synthetic response'),fauxAssistantMessage('second synthetic response')]);
  const modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});
  modelRuntime.registerNativeProvider(faux.provider);
  const bridge=await new Bridge(f.config,async saved=>{
    created++;
    const manager=SessionManager.open(saved.file);
    const {session}=await createAgentSession({cwd:f.cwd,agentDir:path.join(f.dir,'isolated-agent'),modelRuntime,model:faux.getModel(),thinkingLevel:'off',tools:[],resourceLoader:loader(),sessionManager:manager,settingsManager:SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false}})});
    const tasks=[];
    session.subscribe(e=>{if(e.type==='agent_settled')settled++;});
    return {alive:true,state:async()=>({isStreaming:session.isStreaming,isCompacting:session.isCompacting}),entries:async()=>({entries:manager.getEntries(),leafId:manager.getLeafId()}),command:async command=>new Promise((resolve,reject)=>{
      const task=session.prompt(command.message,{streamingBehavior:command.streamingBehavior,preflightResult:disposition=>resolve({disposition})}).catch(reject);tasks.push(task);
    }),stop:async function(){await Promise.all(tasks);session.dispose();this.alive=false;},done:async()=>Promise.all(tasks)};
  }).init();
  try {
    const made=await bridge.create({folder_id:'project',request_id:'empty'});
    const sent=await bridge.send({session_id:made.session_id,request_id:'prompt-1',text:'first',mode:'idle_only'});
    assert.equal(sent.disposition,'started');
    await bridge.pool.get(made.session_id).done();
    const data=await bridge.read({session_id:made.session_id});assert.ok(JSON.stringify(data).includes('first synthetic response'));
    await bridge.pool.stop(made.session_id);
    const sent2=await bridge.send({session_id:made.session_id,request_id:'prompt-2',text:'second',mode:'idle_only'});
    assert.equal(sent2.disposition,'started');await bridge.pool.get(made.session_id).done();
    assert.equal(created,2);assert.equal(faux.state.callCount,2);assert.equal(settled,2);
    const saved=await loadSavedSession(await bridge.session(made.session_id)); assert.ok(saved.entries.some(e=>e.message?.role==='assistant'));
  } finally {await bridge.close();}
});

test('standard MCP stdio client initializes and exercises the single-operation tools alongside batch',async t=>{
  const f=await configFixture(t);f.config.grants[0].send=false;
  const filename=path.join(f.dir,'owner-config.json');await fs.writeFile(filename,JSON.stringify(f.config));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1'},stderr:'pipe'});
  const client=new Client({name:'bridge-protocol-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['batch','create','delete','list','read','send']);
    const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError);return result.structuredContent;};
    const made=await call('create',{folder_id:'project',request_id:'mcp-create'});assert.equal(made.status,'created');
    assert.equal((await call('list',{})).sessions.length,1);
    assert.equal((await call('read',{session_id:made.session_id})).items.length,0);
    const sent=await call('send',{session_id:made.session_id,request_id:'mcp-send',text:'hello'});assert.equal(sent.status,'rejected');
    assert.equal((await call('delete',{session_id:made.session_id,request_id:'mcp-delete'})).status,'deleted');
  } finally {await client.close();}
});

test('MCP -> official Pi RPC -> faux provider: auto-resume, all four modes and content read',async t=>{
  const f=await configFixture(t);
  f.config.piArgs=['--offline','-e',path.join(base,'research/faux-extension.mjs'),'--provider','bridge-fixture','--model','deterministic'];
  const filename=path.join(f.dir,'owner-config.json');await fs.writeFile(filename,JSON.stringify(f.config));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1'},stderr:'pipe'});
  const client=new Client({name:'bridge-e2e-faux-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert.ok(!r.isError,JSON.stringify(r));return r.structuredContent;};
    const made=await call('create',{folder_id:'project',request_id:'create'}); const session_id=made.session_id;
    const first=await call('send',{session_id,request_id:'first',text:'hello',mode:'idle_only'});
    assert.equal(first.status,'accepted',JSON.stringify(first));assert.equal(first.disposition,'started');
    const skipped=await call('send',{session_id,request_id:'skip',text:'should skip',mode:'idle_only'});assert.equal(skipped.status,'skipped');
    const native=await call('send',{session_id,request_id:'busy',text:'should reject',mode:'native'});assert.equal(native.status,'rejected');
    const steer=await call('send',{session_id,request_id:'steer',text:'please steer',mode:'steer'});assert.equal(steer.disposition,'queued');
    const queued=await call('send',{session_id,request_id:'queue',text:'please follow up',mode:'queue'});assert.equal(queued.disposition,'queued');
    assert.deepEqual(await call('send',{session_id,request_id:'first'}),first);
    const deadline=Date.now()+10000;let observed;
    do {
      observed=await call('read',{session_id,view:'context'});
      if (observed.items.filter(x=>x.message?.role==='assistant').length>=3) break;
      await new Promise(r=>setTimeout(r,100));
    } while(Date.now()<deadline);
    assert.equal(observed.items.filter(x=>x.message?.role==='assistant').length,3,JSON.stringify(observed));
    assert.ok(JSON.stringify(observed).includes('please follow up'));
    assert.equal(JSON.stringify(observed).includes('should skip'),false);
    assert.equal(JSON.stringify(observed).includes('should reject'),false);
    const removed=await call('delete',{session_id,request_id:'delete'});assert.equal(removed.status,'deleted');
  } finally {await client.close();}
});


test('real RPC preparation barrier preserves unknown receipts and fences admission until ACK or process exit',async t=>{
  const f=await configFixture(t),extension=path.join(f.dir,'admission-barrier.mjs');
  const entered=path.join(f.dir,'entered.jsonl'),release=path.join(f.dir,'release');
  await fs.writeFile(extension,`import fs from 'node:fs/promises';
import {fauxProvider,fauxAssistantMessage} from ${JSON.stringify(path.join(base,'node_modules/@earendil-works/pi-ai/dist/index.js'))};
export default function(pi){
 globalThis.fetch=async()=>{throw new Error('OFFLINE_FIXTURE');};
 const faux=fauxProvider({provider:'admission-fixture',models:[{id:'slow',name:'Offline admission fixture'}],tokensPerSecond:10,tokenSize:{min:1,max:1}});
 faux.setResponses([fauxAssistantMessage('Long synthetic response holds the first run active for normal steer and queue admission.')]);pi.registerProvider(faux.provider);
 pi.on('before_agent_start',async(event)=>{
  await fs.appendFile(${JSON.stringify(entered)},JSON.stringify({pid:process.pid,prompt:event.prompt})+'\\n');
  if(event.prompt.startsWith('HOLD'))while(!await fs.stat(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(r=>setTimeout(r,5));
 });
}`);
  f.config.piArgs=['--offline','-e',extension,'--provider','admission-fixture','--model','slow','--thinking','off'];
  const bridge=await new Bridge(f.config).init();
  const rows=async()=>{try{return (await fs.readFile(entered,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  const until=async predicate=>{const end=Date.now()+10000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw new Error('ADMISSION_FIXTURE_DEADLINE');};
  try{
   const made=await bridge.create({folder_id:'project',request_id:'create'}),session_id=made.session_id;
   const first=await bridge.send({session_id,request_id:'first',text:'HOLD first',timeout_ms:50});
   assert.equal(first.status,'unknown');assert.equal(first.reason,'ACK_TIMEOUT');
   const runtime=bridge.pool.get(session_id);
   await until(async()=> (await rows()).length===1);
   assert.equal((await runtime.state()).isStreaming,false); // Pi has not published busy during preparation.
   const preparationRead=await bridge.read({session_id});
   assert.equal(preparationRead.activity.source,'rpc_get_state');assert.equal(preparationRead.activity.streaming,false);
   assert.equal(preparationRead.activity.idle,null);assert.equal(preparationRead.activity.preparing,null);assert.equal(preparationRead.activity.bridge_admission.pending,true);
   assert.ok(preparationRead.activity.limitations.includes('idle_not_task_completion'));
   assert.deepEqual(await bridge.send({session_id,request_id:'first'}),first);
   for(const mode of ['native','idle_only','steer','queue']){
    const receipt=await bridge.send({session_id,request_id:'blocked-'+mode,text:'BLOCKED '+mode,mode});
    assert.equal(receipt.status,'rejected');assert.equal(receipt.reason,'PROMPT_ADMISSION_PENDING');
   }
   assert.equal((await rows()).length,1);
   await fs.writeFile(release,'release');
   let recovered;
   await until(async()=>{recovered=await bridge.send({session_id,request_id:'first'});return recovered.status==='accepted';});
   assert.equal(recovered.disposition,'started');assert.equal(recovered.completion,'not_tracked');
   for(const mode of ['steer','queue']){
    const receipt=await bridge.send({session_id,request_id:mode,text:'normal '+mode,mode});
    assert.equal(receipt.status,'accepted');assert.equal(receipt.disposition,'queued');
   }
   assert.equal((await bridge.send({session_id,request_id:'blocked-idle_only'})).reason,'PROMPT_ADMISSION_PENDING');
   assert.equal((await rows()).some(row=>row.prompt.startsWith('BLOCKED')),false);
   await bridge.pool.stop(session_id);
   assert.equal(runtime.exited,true);
   // A separate held admission ends with exact child death, not a late ACK.
   await fs.unlink(release);
   const held=await bridge.send({session_id,request_id:'exit-held',text:'HOLD until exit',timeout_ms:50});
   assert.equal(held.status,'unknown');
   const old=bridge.pool.get(session_id),oldGeneration=old.generation;
   assert.ok(old.promptAdmission);
   await bridge.pool.stop(session_id);
   assert.equal(old.exited,true);assert.equal(old.promptAdmission,null);
   assert.deepEqual(await bridge.send({session_id,request_id:'exit-held'}),held);
   await fs.writeFile(release,'release');
   const next=await bridge.send({session_id,request_id:'after-exit',text:'fresh runtime',timeout_ms:5000});
   assert.equal(next.status,'accepted');assert.equal(next.disposition,'started');
   assert.notEqual(bridge.pool.get(session_id).generation,oldGeneration);
  }finally{await bridge.close();}
});

test('official Pi RPC preserves Unicode line separators in native session messages',async t=>{
 const f=await configFixture(t),bridge=await new Bridge(f.config).init();
 try{
  const made=await bridge.create({folder_id:'project',request_id:'unicode'}),saved=await bridge.session(made.session_id);
  const manager=SessionManager.open(saved.file),content='Before\u2028between\u2029after 😀 汉字';
  manager.appendMessage({role:'user',content,timestamp:Date.now()});
  assert.equal((await bridge.read({session_id:made.session_id})).items[0].message.content,content);
  const runtime=await bridge.pool.resolve(await bridge.session(made.session_id));
  assert.equal((await runtime.state()).sessionId,saved.header.id);
  const live=await bridge.read({session_id:made.session_id});
  assert.equal(live.items[0].message.content,content);assert.equal(live.activity.source,'rpc_get_state');
 }finally{await bridge.close();}
});
