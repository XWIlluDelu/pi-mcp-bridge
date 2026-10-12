import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../src/bridge.mjs';
import {withdrawalCapture,requestRpcStop} from '../src/stop-execution.mjs';
import {createSdkHostBinding,createRpcHostBinding} from '../src/host-bindings.mjs';
import {reserveHostSession} from '../src/host-adapter.mjs';
import {makeServer} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {validateGrants} from '../src/owner-config.mjs';
const gate=()=>Promise.withResolvers();
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-stop-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'stop-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],
   folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,command:true,new_session:true}]};
 let spawned=0;
 const runtime={alive:true,generation:'offline-generation',state:async()=>({isStreaming:false}),
   command:async()=>({disposition:'started'}),stop:async()=>{runtime.alive=false;}};
 const bridge=await new Bridge(config,async()=>{spawned++;return runtime;}).init();
 const made=await bridge.create({folder_id:'project',request_id:'seed'}),saved=await bridge.session(made.session_id);
 let stops=0;
 runtime.stopExecution=async({recovery_id})=>{
   stops++;await withdrawalCapture(bridge.pool.attachmentDir,saved,runtime.generation,recovery_id)({steering:['one'],followUp:['two']});
   return {acknowledgement:'native_ack',coverage:'agent_and_bash'};
 };
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 return {bridge,config,runtime,saved,id:saved.id,spawned:()=>spawned,stops:()=>stops,dir};
}
test('stop is independently authorized, live-only, replay-safe and retains session/process',async t=>{
 const f=await fixture(t);
 assert.equal((await f.bridge.stop({session_id:f.id,request_id:'idle'})).reason,'not_running');assert.equal(f.spawned(),0);
 await f.bridge.send({session_id:f.id,request_id:'start',text:'start'});
 const args={session_id:f.id,request_id:'once'};
 const replies=await Promise.all(Array.from({length:5},()=>f.bridge.stop(args)));
 assert.equal(replies[0].withdrawn_text,'one\n\ntwo');assert.equal(f.stops(),1);assert.equal(f.runtime.alive,true);
 assert.deepEqual(await f.bridge.stop(args),replies[0]);
 f.config.grants.push({session_id:f.id,command:false});
 await assert.rejects(f.bridge.stop({...args,request_id:'prompt-only'}),/NOT_FOUND_OR_DENIED/);
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'prompt-allowed',text:'later'})).status,'accepted');
 f.config.grants.push({session_id:f.id,command:true,send:false});
 assert.equal((await f.bridge.stop({...args,request_id:'command-only'})).status,'accepted');
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'prompt-blocked',text:'no'})).reason,'NOT_FOUND_OR_DENIED');
 f.config.grants.push({session_id:f.id,read:false});
 await assert.rejects(f.bridge.stop({...args,request_id:'no-content-grant'}),/STOP_REQUIRES_READ/);
 await assert.rejects(f.bridge.stop(args),/STOP_REQUIRES_READ/);assert.equal(f.stops(),2);
 assert.throws(()=>validateGrants([{folder:f.saved.cwd,command:'yes'}]),/INVALID_OWNER_CONFIG/);
});
test('stop pages complete native joined text without truncation and replays after Bridge restart',async t=>{
 const f=await fixture(t),text=('Unicode 😀 quote " slash \\ newline\n').repeat(2500),tail='later prompt';
 f.bridge.pool.instances.set(f.id,f.runtime);
 f.runtime.stopExecution=async({recovery_id})=>{
   await withdrawalCapture(f.bridge.pool.attachmentDir,f.saved,f.runtime.generation,recovery_id)({steering:[text],followUp:[tail]});
   return {acknowledgement:'native_ack',coverage:'agent_and_bash'};
 };
 const args={session_id:f.id,request_id:'paged',max_chars:256};let cursor,out='',offset=0;
 do{
   const page=await f.bridge.stop({...args,cursor});
   assert.equal(page.text_offset,offset);assert.ok(JSON.stringify({withdrawn_text:page.withdrawn_text}).length<=256);
   out+=page.withdrawn_text;offset=out.length;cursor=page.next_cursor;
 }while(cursor);
 assert.equal(out,text+'\n\n'+tail);
 const first=await f.bridge.stop(args);
 await assert.rejects(f.bridge.stop({...args,request_id:'wrong',cursor:first.next_cursor}),/RECEIPT_NOT_FOUND/);
 await f.bridge.stop({...args,request_id:'other'});
 await assert.rejects(f.bridge.stop({...args,request_id:'other',cursor:first.next_cursor}),/STALE_CURSOR/);
 const broken=JSON.parse(Buffer.from(first.next_cursor,'base64url'));broken.revision='stale';
 await assert.rejects(f.bridge.stop({...args,cursor:Buffer.from(JSON.stringify(broken)).toString('base64url')}),/STALE_CURSOR/);
 await f.bridge.close();const reopened=await new Bridge(f.config,async()=>assert.fail('replay must not start Pi')).init();
 try{assert.deepEqual(await reopened.stop(args),first);}finally{await reopened.close();}
});
test('stop fences new Bridge prompts, preserves withdrawn text on uncertain ACK, never retries control',async t=>{
 const f=await fixture(t),entered=gate(),finish=gate();f.bridge.pool.instances.set(f.id,f.runtime);
 let calls=0;
 f.runtime.stopExecution=async({recovery_id})=>{
   calls++;await withdrawalCapture(f.bridge.pool.attachmentDir,f.saved,f.runtime.generation,recovery_id)({steering:['recover me'],followUp:[]});
   entered.resolve();await finish.promise;throw Object.assign(new Error('ACK_TIMEOUT'),{uncertain:true});
 };
 const args={session_id:f.id,request_id:'uncertain'},pending=f.bridge.stop(args);await entered.promise;
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'during-stop',text:'must not run'})).reason,'STOP_IN_PROGRESS');
 finish.resolve();const receipt=await pending;
 assert.equal(receipt.status,'unknown');assert.equal(receipt.withdrawn_text,'recover me');
 assert.deepEqual(await f.bridge.stop(args),receipt);assert.equal(calls,1);assert.equal(f.runtime.alive,true);
});
test('native RPC withdrawal and both cancellation requests are submitted before waiting; settling inputs recovered',async()=>{
 const calls=[],finish=gate(),snapshots=[];
 let cleared=0;
 const client={clearQueue:()=>{calls.push('clear');return Promise.resolve({steering:[++cleared===1?'early':'during'],followUp:[]});},
   abort:()=>{calls.push('abort');return finish.promise;},abortBash:()=>{calls.push('bash');return Promise.resolve();}};
 const stopping=requestRpcStop(client,async value=>{snapshots.push(value);});
 assert.deepEqual(calls,['clear','abort','bash']);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(snapshots[0].steering[0],'early');
 finish.resolve();await stopping;assert.deepEqual(snapshots.map(value=>value.steering[0]),['early','during']);
});
test('generic public SDK and RPC bindings withdraw and cancel without invoking release',async()=>{
 const state={sessionFile:'/synthetic/session.jsonl',sessionId:'native'},captured=[],calls=[];
 const session={...state,clearQueue:()=>{calls.push('clear');return {steering:['queued'],followUp:[]};},
   abort:async()=>{calls.push('abort');},abortBash:()=>{calls.push('bash');}};
 const sdk=createSdkHostBinding(session,{release:()=>assert.fail('not release')});
 await sdk.stop({...state,onWithdraw:async value=>{captured.push(value);}});
 assert.deepEqual(calls,['clear','abort','bash','clear']);assert.equal(captured[0].steering[0],'queued');
 calls.length=0;
 const rpc=createRpcHostBinding({...session,getState:async()=>state});
 await rpc.stop({...state,onWithdraw:async()=>{}});
 assert.deepEqual(calls,['clear','abort','bash','clear']);
 await assert.rejects(rpc.stop({...state,sessionId:'wrong',onWithdraw:async()=>{}}),/RUNTIME_SESSION_CHANGED/);
 delete session.abortBash;
 await assert.rejects(createSdkHostBinding(session).stop({...state,onWithdraw:async()=>{}}),/STOP_UNSUPPORTED/);
});
test('generic host IPC and actual MCP return joined editor recovery; missing callback is explicitly unsupported',async t=>{
 const f=await fixture(t),controller=await reserveHostSession({attachmentDir:f.bridge.pool.attachmentDir,session:f.saved});
 t.after(()=>controller.close());
 const state=()=>({sessionFile:f.saved.file,sessionId:f.saved.header.id,isIdle:true});
 const callbacks={state,snapshot:()=>({...state(),entries:[],leafId:null}),submit:async()=>({status:'accepted'})};
 await controller.ready(callbacks);
 const client=new Client({name:'stop-test',version:'1'}),server=makeServer(f.bridge),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(a);await client.connect(b);
 t.after(async()=>{await client.close();await server.close();});
 const tools=await client.listTools();assert.ok(tools.tools.find(tool=>tool.name==='stop'));assert.equal(tools.tools.length,7);
 const call=async(request_id,extra={})=>(await client.callTool({name:'stop',arguments:{session_id:f.id,request_id,...extra}})).structuredContent;
 assert.equal((await call('unsupported')).reason,'STOP_UNSUPPORTED');assert.equal(f.spawned(),0);
 callbacks.stop=async({onWithdraw})=>{
   await onWithdraw({text:'first\n\nsecond\n\nexisting draft',includesEditorDraft:true});
   return {acknowledgement:'requested',coverage:'agent_and_bash'};
 };
 const result=await call('host-stop');assert.equal(result.withdrawn_text,'first\n\nsecond\n\nexisting draft');
 assert.equal(result.includes_editor_draft,true);assert.equal(result.acknowledgement,'requested');
 assert.equal(result.completion,'not_tracked');assert.equal(f.spawned(),0);
 const finished=gate();let calls=0;t.after(()=>finished.resolve());
 callbacks.stop=async({onWithdraw})=>{
   calls++;await onWithdraw({steering:['withdrawn before socket timeout'],followUp:[]});
   await finished.promise;return {acknowledgement:'native_ack',coverage:'agent_and_bash'};
 };
 try{
  const lost=await call('socket-lost',{timeout_ms:50});
  assert.equal(lost.status,'unknown');assert.equal(lost.withdrawn_text,'withdrawn before socket timeout');
  assert.deepEqual(await call('socket-lost'),lost);assert.equal(calls,1);
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'host-fenced',text:'no admission'})).reason,'STOP_IN_PROGRESS');
 }finally{finished.resolve();}
});
