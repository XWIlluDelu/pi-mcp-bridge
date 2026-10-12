import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {reserveHostSession} from '../src/host-adapter.mjs';
import {readClaim,reserveOwner,processIdentity} from '../src/attachments.mjs';
const gate=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-host-')),file=path.join(dir,'session.jsonl'),header={type:'session',version:3,id:'native-fixture',cwd:dir,timestamp:new Date().toISOString()};
 await fs.writeFile(file,JSON.stringify(header)+'\n',{mode:0o600});
 const session={file,header},attachmentDir=path.join(dir,'ipc'),controller=await reserveHostSession({attachmentDir,session});
 t.after(async()=>{await controller.close();await fs.rm(dir,{recursive:true,force:true});});
 const state=()=>({sessionFile:file,sessionId:header.id,isIdle:true,isStreaming:false});
 const snapshot=()=>({...state(),entries:[{type:'message',id:'u',parentId:null,message:{role:'user',content:'PUBLIC_FIXTURE'}}],leafId:'u'});
 const callbacks={state,snapshot,submit:async()=>({status:'accepted',disposition:'started'})};
 return {dir,session,attachmentDir,controller,callbacks};
}
function request(f,op,body={},changes={}){
 return new Promise((resolve,reject)=>{
  const socket=net.createConnection(f.controller.record.socket);let buffer='';socket.setEncoding('utf8');socket.setTimeout(2000,()=>{socket.destroy();reject(new Error('test timeout'));});socket.on('error',reject);
  socket.on('connect',()=>socket.write(JSON.stringify({op,body,file:f.session.file,sessionId:f.session.header.id,generation:f.controller.record.generation,...changes})+'\n'));
  socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){socket.destroy();resolve(JSON.parse(buffer.slice(0,buffer.indexOf('\n'))));}});
 });
}
test('two-phase host reservation blocks another writer before ready and exposes bounded live reads',async t=>{
 const f=await fixture(t);assert.equal((await readClaim(f.attachmentDir,f.session)).phase,'starting');
 await assert.rejects(reserveOwner(f.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
 await f.controller.ready(f.callbacks);
 assert.equal((await readClaim(f.attachmentDir,f.session)).phase,'ready');
 const read=await request(f,'read',{view:'context'});assert.ok(JSON.stringify(read.data).includes('PUBLIC_FIXTURE'));assert.equal(read.data.activity.source,'host_context');
 assert.equal((await request(f,'state')).data.sessionId,f.session.header.id);
 assert.equal((await request(f,'send',{text:'fixture',mode:'native'})).data.status,'accepted');
 assert.equal((await request(f,'send',{text:'fixture',mode:'native'},{generation:'stale'})).error,'RUNTIME_SESSION_CHANGED');
});
test('host state forwards only validated nonnegative integer pending counts',async t=>{
 const f=await fixture(t),state=f.callbacks.state;let count;
 f.callbacks.state=()=>({...state(),...(count===undefined?{}:{pendingMessageCount:count})});
 await f.controller.ready(f.callbacks);
 for(const [input,expected] of [[0,0],[3,3],[undefined,null],[-1,null],[1.5,null],['3',null],[null,null],[NaN,null],[Infinity,null],[Number.MAX_SAFE_INTEGER+1,null]]){
  count=input;
  assert.equal((await request(f,'state')).data.pendingMessageCount,expected);
  const {activity}=(await request(f,'read',{view:'context'})).data;
  assert.equal(activity.pending_message_count,expected);
  assert.equal(activity.pending_messages,expected===null?null:expected>0);
 }
});
test('host release waits for admitted preparation, fences new input, and releases shared PID without killing it',async t=>{
 const f=await fixture(t),entered=gate(),finish=gate();let released=false;
 f.callbacks.submit=async()=>{entered.resolve();await finish.promise;assert.equal(released,false);return {status:'unknown'};};
 f.callbacks.release=async()=>{released=true;return {released:true};};
 await f.controller.ready(f.callbacks);
 const sending=request(f,'send',{text:'fixture',mode:'native'});await entered.promise;
 const releasing=f.controller.release();
 assert.ok(await readClaim(f.attachmentDir,f.session));assert.equal(released,false);
 assert.equal((await request(f,'send',{text:'second',mode:'native'})).error,'RUNTIME_SESSION_CHANGED');
 finish.resolve();assert.equal((await sending).data.status,'unknown');assert.deepEqual(await releasing,{released:true,generation:f.controller.record.generation});
 assert.equal(await readClaim(f.attachmentDir,f.session),null);assert.ok(await processIdentity());
});
test('controller close retains live writer claim and unsupported release remains explicit',async t=>{
 const f=await fixture(t);await f.controller.ready(f.callbacks);
 assert.equal((await request(f,'release')).error,'HOST_RELEASE_UNSUPPORTED');
 await f.controller.close();const claim=await readClaim(f.attachmentDir,f.session);assert.equal(claim.phase,'transitioning');assert.equal(claim.owner.pid,process.pid);
 await assert.rejects(reserveOwner(f.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
});
test('missing or switched native identity never publishes ready or dispatches a prompt',async t=>{
 const f=await fixture(t);f.callbacks.state=()=>undefined;
 await assert.rejects(f.controller.ready(f.callbacks),/RUNTIME_SESSION_CHANGED/);assert.equal((await readClaim(f.attachmentDir,f.session)).phase,'starting');
});
test('identity is checked after asynchronous host submission',async t=>{
 const f=await fixture(t);let changed=false;
 const state=f.callbacks.state;f.callbacks.state=()=>({...state(),sessionId:changed?'different':f.session.header.id});
 f.callbacks.submit=async()=>{changed=true;return {status:'accepted',disposition:'started'};};
 await f.controller.ready(f.callbacks);
 assert.equal((await request(f,'send',{text:'fixture',mode:'native'})).error,'RUNTIME_SESSION_CHANGED');
 assert.ok(await readClaim(f.attachmentDir,f.session));
});
test('close during readiness verification cannot publish a new endpoint',async t=>{
 const f=await fixture(t),entered=gate(),finish=gate(),state=f.callbacks.state;
 f.callbacks.state=async()=>{entered.resolve();await finish.promise;return state();};
 const publishing=f.controller.ready(f.callbacks);await entered.promise;await f.controller.close();finish.resolve();
 await assert.rejects(publishing,/RUNTIME_SESSION_CHANGED/);assert.equal((await readClaim(f.attachmentDir,f.session)).phase,'transitioning');
 await assert.rejects(fs.stat(f.controller.record.socket),{code:'ENOENT'});
});
test('read snapshots are detached before awaited identity checks and later host mutations',async t=>{
 const f=await fixture(t),snapshot=f.callbacks.snapshot(),before=JSON.stringify(snapshot.entries);
 let reads=0;
 f.callbacks.snapshot=()=>snapshot;
 const state=f.callbacks.state;
 f.callbacks.state=()=>{reads++;if(reads===4)snapshot.entries[0].message.content='LATER_MUTATION';return state();};
 await f.controller.ready(f.callbacks); // two state verifications
 const result=await request(f,'read',{view:'raw'});
 assert.equal(reads,4);assert.notEqual(JSON.stringify(snapshot.entries),before);
 assert.ok(JSON.stringify(result.data).includes('PUBLIC_FIXTURE'));assert.ok(!JSON.stringify(result.data).includes('LATER_MUTATION'));
});
test('publication failure after listening closes endpoint while retaining ownership',async t=>{
 const f=await fixture(t),state=f.callbacks.state;let calls=0;
 f.callbacks.state=()=>{calls++;return calls===1?state():{...state(),sessionId:'changed'};};
 await assert.rejects(f.controller.ready(f.callbacks),/RUNTIME_SESSION_CHANGED/);
 assert.ok(await readClaim(f.attachmentDir,f.session));
 await assert.rejects(request(f,'state'));
});
test('malformed host snapshot identity fields cannot become a read response',async t=>{
 const f=await fixture(t),snapshot=f.callbacks.snapshot();f.callbacks.snapshot=()=>({...snapshot,leafId:42});await f.controller.ready(f.callbacks);
 assert.equal((await request(f,'read',{view:'raw'})).error,'INVALID_HOST_SNAPSHOT');
 f.callbacks.snapshot=()=>({...snapshot,entries:[{id:4}]});
 assert.equal((await request(f,'read',{view:'raw'})).error,'INVALID_HOST_SNAPSHOT');
});
test('successful IPC release flushes its acknowledgment and retires the listener without closing the host',async t=>{
 const f=await fixture(t);f.callbacks.release=async()=>({released:true});await f.controller.ready(f.callbacks);
 const result=await request(f,'release');assert.deepEqual(result.data,{released:true,generation:f.controller.record.generation});
 assert.equal(await readClaim(f.attachmentDir,f.session),null);
 await assert.rejects(request(f,'state'));
 assert.ok(await processIdentity());await f.controller.close();await f.controller.close();
});
