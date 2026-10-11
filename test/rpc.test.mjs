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
  assert.equal(selected.env.HOME,'/tmp/state/pi-home');
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
