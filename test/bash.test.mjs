import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Bridge} from '../src/bridge.mjs';
import {reserveHostSession} from '../src/host-adapter.mjs';
import {makeServer} from '../src/server.mjs';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {validateGrants} from '../src/owner-config.mjs';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-bash-api-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const rule={folder:cwd,read:true,send:true,command:true,new_session:true},config={principal:'bash-api',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[rule]};
 const bridge=await new Bridge(config,async()=>assert.fail('no fallback writer')).init();
 const made=await bridge.create({folder_id:'project',request_id:'seed'}),saved=await bridge.session(made.session_id);
 const controller=await reserveHostSession({attachmentDir:bridge.pool.attachmentDir,session:saved});
 let calls=0;const output='complete 😀 "\\ result\n'.repeat(1500);
 const callbacks={state:async()=>({sessionFile:saved.file,sessionId:saved.header.id}),snapshot:async()=>({entries:[],leafId:null}),
  submit:async()=>({status:'unknown'}),stop:async({onWithdraw})=>{await onWithdraw({steering:[],followUp:[]});return {acknowledgement:'native_ack',coverage:'agent_and_bash'};},
  bash:async({beforeDispatch,onResult})=>{beforeDispatch();calls++;await onResult({output,exitCode:0,cancelled:false,truncated:false});return {completed:true};}};
 await controller.ready(callbacks);
 const client=new Client({name:'direct-bash-api-fixture',version:'1'}),server=makeServer(bridge),[a,b]=InMemoryTransport.createLinkedPair();
 await Promise.all([server.connect(a),client.connect(b)]);
 t.after(async()=>{await client.close();await server.close();await controller.close();await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const call=async args=>client.callTool({name:'bash',arguments:{session_id:saved.id,...args}});
 return {bridge,config,rule,saved,client,call,calls:()=>calls,callbacks,output};
}
test('MCP native bash switch is independent, defaults off and gates execution/replay at backend',async t=>{
 const f=await fixture(t);assert.ok((await f.client.listTools()).tools.some(tool=>tool.name==='bash'));
 assert.equal((await f.call({request_id:'disabled',command:'must not run'})).isError,true);assert.equal(f.calls(),0);
 validateGrants([{folder:f.saved.cwd,bash:true},{session_id:f.saved.id,bash:null}]);
 assert.throws(()=>validateGrants([{folder:f.saved.cwd,bash:'enabled'}]));
 Object.assign(f.rule,{bash:true,send:false,command:false,read:false});
 let response=await f.call({request_id:'own-result',command:'native command',max_chars:512});
 assert.ok(!response.isError);let result=response.structuredContent,output=result.output;
 assert.equal(result.exitCode,0);assert.equal(result.truncated,false);assert.ok(result.next_cursor);
 const bad=await f.call({request_id:'new-binding',cursor:result.next_cursor});assert.equal(bad.isError,true);assert.equal(f.calls(),1);
 while(result.next_cursor){
  response=await f.call({request_id:'own-result',cursor:result.next_cursor,max_chars:32768});
  assert.ok(!response.isError);result=response.structuredContent;output+=result.output;
 }
 assert.equal(output,f.output);assert.equal(f.calls(),1);
 assert.equal((await f.bridge.send({session_id:f.saved.id,request_id:'prompt-denied',text:'prompt'})).status,'rejected');
 f.rule.bash=false;assert.equal((await f.call({request_id:'own-result'})).isError,true);assert.equal(f.calls(),1);
 f.rule.bash=true;assert.equal((await f.call({request_id:'own-result'})).structuredContent.total_text_units,f.output.length);assert.equal(f.calls(),1);
 const wrong=await f.call({request_id:'own-result',command:'different'});assert.equal(wrong.isError,true);
});
test('native bash ACK uncertainty retains captured output and never repeats execution',async t=>{
 const f=await fixture(t),finish=Promise.withResolvers(),entered=Promise.withResolvers();f.rule.bash=true;
 f.callbacks.bash=async({onResult})=>{entered.resolve();await onResult({output:'result before lost ACK',exitCode:0,cancelled:false,truncated:false});await finish.promise;return {completed:true};};
 try{
  const request=f.call({request_id:'slow-ack',command:'fixture',timeout_ms:50});await entered.promise;
  assert.equal((await f.call({request_id:'concurrent',command:'do not queue'})).structuredContent.reason,'BASH_IN_PROGRESS');
  const result=(await request).structuredContent;assert.equal(result.status,'unknown');assert.equal(result.output,'result before lost ACK');
  assert.deepEqual((await f.call({request_id:'slow-ack'})).structuredContent,result);
 }finally{finish.resolve();}
});
