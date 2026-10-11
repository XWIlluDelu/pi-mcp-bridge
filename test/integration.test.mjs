import { test } from 'node:test';
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
  const config={principal:'isolated-test',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
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
  f.config.piArgs=['-e',extension];
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
    const saved=await bridge.session(made.session_id); assert.ok(saved.entries.some(e=>e.message?.role==='assistant'));
  } finally {await bridge.close();}
});

test('standard MCP stdio client initializes and exercises all five tools',async t=>{
  const f=await configFixture(t);f.config.grants[0].send=false;
  const filename=path.join(f.dir,'owner-config.json');await fs.writeFile(filename,JSON.stringify(f.config));
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1'},stderr:'pipe'});
  const client=new Client({name:'bridge-protocol-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['create','delete','list','read','send']);
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
  f.config.piArgs=['-e',path.join(base,'research/faux-extension.mjs'),'--provider','bridge-fixture','--model','deterministic'];
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
