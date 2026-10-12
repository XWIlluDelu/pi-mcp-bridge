import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PiRpc, RpcFailure, RuntimePool, launchProfile } from '../src/rpc.mjs';

test('launcher defaults isolate credentials; owner profile inherits only named variables',()=>{
  const host={PATH:'/bin',OPENAI_API_KEY:'synthetic-key',HTTPS_PROXY:'http://synthetic-proxy',OTHER_KEY:'private',HOME:'/owner'};
  const config={stateDir:'/tmp/state'};
  const isolated=launchProfile(config,host);
  assert.equal(isolated.env.OPENAI_API_KEY,undefined);
  assert.equal(isolated.env.HTTPS_PROXY,undefined);
  assert.deepEqual(isolated.toolArgs,['--no-tools']);
  const selected=launchProfile({...config,piRuntime:{agentDir:'/tmp/pi-profile',inheritEnv:['OPENAI_API_KEY','HTTPS_PROXY','HOME'],tools:['read','write']}},host);
  assert.equal(selected.env.OPENAI_API_KEY,'synthetic-key');
  assert.equal(selected.env.HTTPS_PROXY,'http://synthetic-proxy');
  assert.equal(selected.env.OTHER_KEY,undefined);
  assert.equal(selected.env.HOME,'/owner');
  assert.deepEqual(selected.resourceArgs,[]);
  assert.deepEqual(isolated.resourceArgs,['--no-extensions','--no-skills','--no-prompt-templates','--no-themes']);
  const homeOnly=launchProfile({...config,piRuntime:{inheritEnv:['HOME']}},host);
  assert.equal(homeOnly.env.HOME,'/owner');
  assert.equal(homeOnly.env.PI_CODING_AGENT_DIR,'/tmp/state/pi-home/.pi/agent');
  assert.deepEqual(homeOnly.resourceArgs,isolated.resourceArgs);
  assert.equal(selected.env.PI_CODING_AGENT_DIR,'/tmp/pi-profile');
  assert.deepEqual(selected.toolArgs,['--tools','read,write']);
  assert.throws(()=>launchProfile({...config,piRuntime:{agentDir:'relative'}}),/INVALID_PI_RUNTIME/);
});

test('switched Pi runtime stops before reading or sending under original identity',async()=>{
  for (const command of [{type:'get_entries'},{type:'prompt',message:'fixture'}]) {
    const rpc=new PiRpc({},{file:'/sessions/a.jsonl',header:{id:'a'}});
    let stopped=false;const calls=[];
    rpc.stop=async()=>{stopped=true;};
    rpc.dispatch=async c=>{calls.push(c.type);return {sessionFile:'/sessions/b.jsonl',sessionId:'b'};};
    await assert.rejects(rpc.command(command),{code:'RUNTIME_SESSION_CHANGED'});
    assert.equal(stopped,true);assert.deepEqual(calls,['get_state']);
  }
});

test('identity change during read suppresses content; during prompt preserves uncertainty',async()=>{
  for (const type of ['get_entries','prompt']) {
    const rpc=new PiRpc({},{file:'/sessions/a.jsonl',header:{id:'a'}});let states=0;
    rpc.stop=async()=>{};
    rpc.dispatch=async c=>c.type==='get_state' ? (++states===1 ? {sessionFile:'/sessions/a.jsonl',sessionId:'a'} : {sessionFile:'/sessions/b.jsonl',sessionId:'b'}) : {entries:['private'],disposition:'started'};
    await assert.rejects(rpc.command({type}),error=>error.code==='RUNTIME_SESSION_CHANGED' && error.uncertain===(type==='prompt'));
  }
});

test('authoritative Pi rejection still verifies identity and stops a switched process',async()=>{
  const rpc=new PiRpc({},{file:'/sessions/a.jsonl',header:{id:'a'}});let states=0,stopped=false;
  rpc.stop=async()=>{stopped=true;};
  rpc.dispatch=async c=>{
    if(c.type!=='get_state')throw new RpcFailure('PI_REJECTED');
    return ++states===1 ? {sessionFile:'/sessions/a.jsonl',sessionId:'a'} : {sessionFile:'/sessions/b.jsonl',sessionId:'b'};
  };
  await assert.rejects(rpc.command({type:'prompt'}),error=>error.code==='RUNTIME_SESSION_CHANGED'&&error.uncertain);
  assert.equal(stopped,true);assert.equal(states,2);
});

test('RPC pipe failure still requires confirmed process exit before stop returns',async()=>{
  const rpc=new PiRpc({},{});const child=new EventEmitter();let terminated=false,exited=false;
  child.kill=()=>{terminated=true;setImmediate(()=>{exited=true;child.emit('exit',0);});};
  rpc.child=child;rpc.alive=false;rpc.exited=false;
  await rpc.stop();assert.equal(terminated,true);assert.equal(exited,true);
});
test('pool terminates an unusable old runtime before replacement',async()=>{
  let stopped=false;
  const pool=new RuntimePool({},async()=>{assert.equal(stopped,true);return {alive:true,stop:async()=>{}};});
  pool.instances.set('s',{alive:false,stop:async()=>{await new Promise(r=>setImmediate(r));stopped=true;}});
  await pool.resolve({id:'s'});await pool.close();
});

test('unresolved prompt admission survives timeout, idle, malformed and old-generation replies',async()=>{
 const rpc=new PiRpc({},{}),writes=[];rpc.alive=true;
 rpc.child={stdin:{write:line=>writes.push(JSON.parse(line))}};
 let late;
 await assert.rejects(rpc.dispatch({type:'prompt',message:'first'},10,result=>{late=result;}),{code:'ACK_TIMEOUT',uncertain:true});
 const first=writes[0],generation=rpc.generation;
 const state=rpc.dispatch({type:'get_state'},1000);const stateRequest=writes.at(-1);
 rpc.receiveResponse({type:'response',id:stateRequest.id,success:true,data:{isStreaming:false}},generation);await state;
 for(const event of [
  {type:'agent_settled',aborted:false},
  {type:'response',id:first.id,command:'get_state',success:true,data:{disposition:'started'}},
  {type:'response',id:first.id,command:'prompt',success:true,data:{}},
 ])rpc.receiveResponse(event,generation);
 const ack={type:'response',id:first.id,command:'prompt',success:true,data:{disposition:'started'}};
 rpc.receiveResponse(ack,'old-generation');
 await assert.rejects(rpc.dispatch({type:'prompt',message:'second'}),{code:'PROMPT_ADMISSION_PENDING',uncertain:false});
 assert.equal(writes.filter(x=>x.type==='prompt').length,1);
 rpc.receiveResponse(ack,generation);assert.equal(late.data.disposition,'started');
 const next=rpc.dispatch({type:'prompt',message:'next',streamingBehavior:'steer'},1000),nextRequest=writes.at(-1);
 rpc.receiveResponse(ack,generation);assert.equal(rpc.promptAdmission.id,nextRequest.id);
 rpc.receiveResponse({type:'response',id:nextRequest.id,command:'prompt',success:true,data:{disposition:'queued'}},generation);
 assert.equal((await next).disposition,'queued');
});
test('write uncertainty retains admission; authoritative rejection or confirmed exit releases it',async()=>{
 for(const failure of ['callback','throw']){
  const rpc=new PiRpc({},{});rpc.alive=true;let written;
  const child=new EventEmitter();child.stdin={write:(line,cb)=>{written=JSON.parse(line);if(failure==='throw')throw new Error('synthetic');cb(new Error('synthetic'));}};rpc.child=child;
  await assert.rejects(rpc.dispatch({type:'prompt',message:'first'},1000),{code:'WRITE_UNKNOWN',uncertain:true});
  assert.ok(rpc.promptAdmission);
  await assert.rejects(rpc.dispatch({type:'prompt',message:'second'}),{code:'PROMPT_ADMISSION_PENDING'});
  if(failure==='callback'){
   rpc.receiveResponse({type:'response',id:written.id,command:'prompt',success:false},rpc.generation);assert.equal(rpc.promptAdmission,null);
  }else{
   child.kill=()=>{assert.ok(rpc.promptAdmission);setImmediate(()=>child.emit('exit',0));};
   await rpc.stop();assert.equal(rpc.promptAdmission,null);assert.equal(rpc.exited,true);
  }
 }
});

test('silent live child does not retain expired read requests while prompt ACK recovery stays fenced',async()=>{
 const rpc=new PiRpc({},{}),writes=[];rpc.alive=true;
 rpc.child={stdin:{write:line=>writes.push(JSON.parse(line))}};
 let lateReads=0;
 for(let i=0;i<12;i++){
  await assert.rejects(rpc.dispatch({type:i%2?'get_entries':'get_state'},1,()=>lateReads++),{code:'ACK_TIMEOUT'});
  assert.equal(rpc.pending.size,0);assert.equal(rpc.promptAdmission,null);
 }
 for(const request of writes)rpc.receiveResponse({type:'response',id:request.id,success:true,data:{}},rpc.generation);
 assert.equal(lateReads,0);
 let latePrompt;
 await assert.rejects(rpc.dispatch({type:'prompt',message:'held'},1,result=>{latePrompt=result;}),{code:'ACK_TIMEOUT'});
 const prompt=writes.at(-1);assert.equal(rpc.pending.size,1);
 for(const failure of ['callback','throw']){
  rpc.child.stdin.write=(_line,cb)=>{if(failure==='throw')throw new Error('fixture');cb(new Error('fixture'));};
  await assert.rejects(rpc.dispatch({type:'get_entries'},50),{code:'WRITE_UNKNOWN'});
  assert.equal(rpc.pending.size,1);assert.equal(rpc.promptAdmission.id,prompt.id);
 }
 rpc.receiveResponse({type:'response',id:prompt.id,command:'prompt',success:true,data:{disposition:'started'}},rpc.generation);
 assert.equal(latePrompt.ok,true);assert.equal(rpc.pending.size,0);assert.equal(rpc.promptAdmission,null);
});

test('entry read reuses its identity postcheck for activity without another RPC',async()=>{
 const rpc=new PiRpc({},{file:'/sessions/a.jsonl',header:{id:'a'}}),calls=[];
 rpc.promptAdmission={id:'unresolved',generation:rpc.generation};
 rpc.dispatch=async command=>{
  calls.push(command.type);
  if(command.type==='get_entries')return {entries:[],leafId:null};
  return {sessionFile:rpc.session.file,sessionId:'a',isStreaming:false,isCompacting:false,pendingMessageCount:2};
 };
 const result=await rpc.entries();
 assert.deepEqual(calls,['get_state','get_entries','get_state']);
 assert.equal(result.activity.source,'rpc_get_state');assert.equal(result.activity.streaming,false);
 assert.equal(result.activity.idle,null);assert.equal(result.activity.preparing,null);
 assert.equal(result.activity.pending_messages,true);assert.equal(result.activity.pending_message_count,2);
 assert.equal(result.activity.bridge_admission.pending,true);assert.ok(Date.parse(result.activity.observed_at));
 rpc.dispatch=async command=>command.type==='get_entries'?{entries:[],leafId:null}:{sessionFile:rpc.session.file,sessionId:'a'};
 const missing=(await rpc.entries()).activity;assert.equal(missing.streaming,null);assert.equal(missing.pending_messages,null);assert.equal(missing.pending_message_count,null);
});

test('actual RPC launch rejects null, missing and symlink-replaced cwd without spawning',async t=>{
 const fs=await import('node:fs/promises'),path=await import('node:path');
 const dir=await fs.mkdtemp('/tmp/pi-cwd-launch-');t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 for(const kind of ['null','missing','symlink','after-reservation']){
  const root=path.join(dir,kind),cwd=path.join(root,'project');await fs.mkdir(cwd,{recursive:true});
  const file=path.join(root,'session.jsonl'),header={type:'session',version:3,id:kind,cwd};await fs.writeFile(file,JSON.stringify(header)+'\n');
  const config={stateDir:path.join(root,'state'),attachmentDir:path.join(root,'ipc')};
  const session={file,header,cwd:kind==='null'?null:cwd};
  if(kind==='missing')await fs.rmdir(cwd);
  if(kind==='symlink'){await fs.rename(cwd,cwd+'-moved');await fs.symlink(cwd+'-moved',cwd);}
  const rename=fs.default.rename;let retargeted=false;
  if(kind==='after-reservation')t.mock.method(fs.default,'rename',async(from,to)=>{
   await rename(from,to);
   if(to.endsWith('.owner.json')&&!retargeted){retargeted=true;await rename(cwd,cwd+'-moved');await fs.symlink(cwd+'-moved',cwd);}
  });
  const rpc=new PiRpc(config,session);
  try {
   await assert.rejects(rpc.start(),/EXECUTION_CWD_UNAVAILABLE/);
   assert.equal(rpc.child,undefined);assert.equal(rpc.alive,false);
   assert.deepEqual((await fs.readdir(config.attachmentDir)).filter(name=>name.endsWith('.owner.json')),[]);
   if(kind==='after-reservation')assert.equal(retargeted,true);
  } finally {t.mock.restoreAll();await rpc.stop();}
 }
});
