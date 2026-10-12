import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { executeBatch } from '../src/batch.mjs';
import { readSchema } from '../src/tool-schemas.mjs';

async function fixture(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-status-')),cwd=path.join(dir,'project');
  await fs.mkdir(cwd);
  const config={principal:'status-test',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
  const bridge=await new Bridge(config,()=>{throw new Error('STATUS_MUST_NOT_SPAWN');}).init();
  const made=await bridge.create({folder_id:'project',request_id:'seed'}),session=await bridge.session(made.session_id);
  let states=0;
  const runtime={alive:true,generation:'status-generation',settlement:{generation:'status-generation',sequence:0,observed_at:null,aborted:null},
    state:async()=>{states++;return {sessionFile:session.file,sessionId:session.header.id,isStreaming:false,pendingMessageCount:0};},
    entries:()=>{throw new Error('STATUS_MUST_NOT_READ_ENTRIES');},stop:async()=>{runtime.alive=false;}};
  t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,bridge,config,id:made.session_id,session,runtime,states:()=>states};
}
test('status skips saved transcript loading and live entries and never spawns',async t=>{
  const f=await fixture(t);
  await fs.appendFile(f.session.file,'invalid transcript body\n'+'x'.repeat(500000));
  const saved=await f.bridge.read({session_id:f.id,view:'status'});
  assert.equal(saved.generation,null);assert.equal(saved.activity.source,'none');assert.equal(saved.wait.status,'not_requested');
  f.bridge.pool.instances.set(f.id,f.runtime);
  const live=await f.bridge.read({session_id:f.id,view:'status'});
  assert.equal(f.states(),1);assert.equal(live.generation,f.runtime.generation);assert.equal(live.activity.settlement.sequence,0);
  assert.ok(!('items' in live));assert.ok(JSON.stringify(live).length<1000);
  const batch=await executeBatch(f.bridge,{operations:[{op:'read',args:{session_id:f.id,view:'status'}}]});
  assert.equal(batch.results[0].result.view,'status');assert.ok(!('applied_max_chars' in batch.results[0]));
  f.config.grants[0].read=false;
  await assert.rejects(f.bridge.read({session_id:f.id,view:'status'}),/NOT_FOUND_OR_DENIED/);
  assert.equal(f.states(),2);
});
test('bounded wait distinguishes settlement, timeout, generation replacement and unsupported observation',async t=>{
  const f=await fixture(t);f.bridge.pool.instances.set(f.id,f.runtime);
  const after_settlement={generation:f.runtime.generation,sequence:0},args={session_id:f.id,view:'status',after_settlement};
  assert.equal((await f.bridge.read(args)).wait.status,'timeout');
  const pending=f.bridge.read({...args,wait_ms:1000});
  const timer=setTimeout(()=>{f.runtime.settlement={...f.runtime.settlement,sequence:1,observed_at:new Date().toISOString(),aborted:false};},25);
  try{assert.equal((await pending).wait.status,'settled');}finally{clearTimeout(timer);}
  const snapshot=await f.bridge.read({...args,after_settlement:{...after_settlement,sequence:1},wait_ms:20});
  assert.equal(snapshot.wait.status,'timeout');
  f.runtime.generation='new-generation';f.runtime.settlement={generation:'new-generation',sequence:0,observed_at:null,aborted:null};
  assert.equal((await f.bridge.read({...args,wait_ms:1000})).wait.status,'generation_changed');
  delete f.runtime.settlement;
  assert.equal((await f.bridge.read({...args,wait_ms:1000})).wait.status,'unavailable');
  f.bridge.pool.instances.delete(f.id);
  assert.equal((await f.bridge.read({...args,wait_ms:1000})).wait.status,'unavailable');
});
test('expired status wait returns the last healthy observation without another state request',async t=>{
  const f=await fixture(t);f.bridge.pool.instances.set(f.id,f.runtime);
  const timeouts=[];
  f.runtime.state=async(timeout=5000)=>{
    timeouts.push(timeout);
    await new Promise(resolve=>setTimeout(resolve,5));
    if(timeout<5)throw new Error('ACK_TIMEOUT');
    return {isStreaming:false,pendingMessageCount:0};
  };
  const result=await f.bridge.readStatus(f.session,{session_id:f.id,view:'status',after_settlement:{generation:f.runtime.generation,sequence:0},wait_ms:50});
  assert.equal(result.wait.status,'timeout');
  assert.equal(result.activity.settlement.sequence,0);
  assert.equal(timeouts.length,1);
  assert.deepEqual(timeouts,[5000]);
});
test('a healthy observation near poll expiry keeps the normal state timeout',async t=>{
  const f=await fixture(t),timeouts=[];let now=0,owners=0;
  t.mock.method(Date,'now',()=>now);
  f.bridge.pool.forRead=async()=>{if(++owners===2)now=105;return f.runtime;};
  f.runtime.state=async(timeout=5000)=>{
    timeouts.push(timeout);
    await new Promise(resolve=>setTimeout(resolve,5));now+=5;
    if(timeout<5)throw new Error('ACK_TIMEOUT');
    return {isStreaming:false,pendingMessageCount:0};
  };
  const result=await f.bridge.readStatus(f.session,{session_id:f.id,view:'status',after_settlement:{generation:f.runtime.generation,sequence:0},wait_ms:107});
  assert.equal(result.wait.status,'timeout');assert.equal(owners,2);
  assert.deepEqual(timeouts,[5000,5000]);
});
test('expiry during ownership resolution returns the last authorized observation without state I/O',async t=>{
  const f=await fixture(t),generation=f.runtime.generation;let now=0,owners=0,states=0;
  t.mock.method(Date,'now',()=>now);
  f.bridge.pool.forRead=async()=>{if(++owners===2){now=108;f.runtime.generation='unobserved-generation';}return f.runtime;};
  f.runtime.state=async()=>{states++;now+=5;return {isStreaming:states>1,pendingMessageCount:0};};
  const result=await f.bridge.readStatus(f.session,{session_id:f.id,view:'status',after_settlement:{generation,sequence:0},wait_ms:107});
  assert.equal(result.wait.status,'timeout');assert.equal(result.generation,generation);
  assert.equal(result.activity.streaming,false);assert.equal(owners,2);assert.equal(states,1);
});
test('status propagates genuine state and owner failures unchanged',async t=>{
  const f=await fixture(t),args={session_id:f.id,view:'status',after_settlement:{generation:f.runtime.generation,sequence:0},wait_ms:0};
  const stateError=new Error('ACK_TIMEOUT');
  f.bridge.pool.instances.set(f.id,f.runtime);f.runtime.state=async()=>{throw stateError;};
  await assert.rejects(f.bridge.readStatus(f.session,args),error=>error===stateError);
  const ownerError=new Error('LIVE_OWNER_UNREACHABLE');
  f.bridge.pool.forRead=async()=>{throw ownerError;};
  await assert.rejects(f.bridge.readStatus(f.session,args),error=>error===ownerError);
});
test('waiting rechecks permissions and cancellation without transcript reads',async t=>{
  const f=await fixture(t);f.bridge.pool.instances.set(f.id,f.runtime);
  const args={session_id:f.id,view:'status',after_settlement:{generation:f.runtime.generation,sequence:0},wait_ms:1000};
  const pending=f.bridge.read(args);const denied=setTimeout(()=>{f.config.grants[0].read=false;},25);
  try{await assert.rejects(pending,/NOT_FOUND_OR_DENIED/);}finally{clearTimeout(denied);}
  f.config.grants[0].read=true;
  const controller=new AbortController(),cancelled=f.bridge.read(args,{signal:controller.signal});
  const abort=setTimeout(()=>controller.abort(),25);
  try{await assert.rejects(cancelled,/READ_CANCELLED/);}finally{clearTimeout(abort);}
});
test('status/filter/wait contradictions reject a batch before any mutation',async()=>{
  const status={session_id:'s',view:'status'},baseline={generation:'g',sequence:0};
  for(const args of [{...status,wait_ms:1},{...status,after_settlement:baseline,wait_ms:10001},{...status,cursor:'no'},{session_id:'s',wait_ms:0},{session_id:'s',after_settlement:baseline}]){
    assert.equal(readSchema.safeParse(args).success,false);
    let calls=0;
    const result=await executeBatch({create:async()=>{calls++;}},{operations:[{op:'create',args:{folder_id:'p',request_id:'before-invalid-status'}},{op:'read',args}]});
    assert.equal(result.status,'rejected');assert.equal(calls,0);
  }
  assert.ok(readSchema.safeParse({...status,after_settlement:baseline,wait_ms:10000}).success);
});
