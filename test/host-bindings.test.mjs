import test from 'node:test';
import assert from 'node:assert/strict';
import { createSdkHostBinding,createRpcHostBinding } from '../src/host-bindings.mjs';

const idle={sessionFile:'/public/session.jsonl',sessionId:'public-id',isIdle:true,isStreaming:false,isCompacting:false,pendingMessageCount:0};
function sdk(prompt){return {...idle,prompt,sessionManager:{getEntries:()=>[{id:'entry',type:'message'}],getLeafId:()=> 'entry'}};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('SDK dispatch reports unknown without waiting for completion and tracks drain',async()=>{
 const completion=Promise.withResolvers(),calls=[];let released=false;
 const binding=createSdkHostBinding(sdk((text,opts)=>{calls.push([text,opts]);return completion.promise;}),{release:async()=>{released=true;completion.resolve();return {released:true};}});
 assert.deepEqual(await binding.submit({text:'public',mode:'steer'}),{status:'unknown',dispatch:'submitted',reason:'PI_ACCEPTANCE_UNOBSERVABLE',completion:'not_tracked'});
 assert.deepEqual(calls,[['public',{streamingBehavior:'steer'}]]);
 assert.equal(released,false);assert.deepEqual(await binding.release(),{released:true});assert.equal(released,true);
});

test('SDK completion failure stays unknown and raw failures remain host-local',async()=>{
 const completion=Promise.withResolvers(),errors=[];
 const binding=createSdkHostBinding(sdk(()=>completion.promise),{onError:error=>errors.push(error)});
 const receipt=await binding.submit({text:'public',mode:'queue'});
 completion.reject(new Error('PRIVATE_PROVIDER_ERROR'));await tick();
 assert.equal(receipt.status,'unknown');assert.equal(errors.length,1);
 assert.equal(JSON.stringify(receipt).includes('PRIVATE'),false);
 const sync=createSdkHostBinding(sdk(()=>{throw new Error('PRIVATE_SYNC_FAILURE');}));
 assert.equal((await sync.submit({text:'public'})).status,'unknown');
});

test('SDK snapshot clones entries and idle-only busy never dispatches',async()=>{
 let calls=0;const session=sdk(()=>{calls++;});session.isIdle=false;
 const binding=createSdkHostBinding(session);
 assert.deepEqual(await binding.submit({text:'public',mode:'idle_only'}),{status:'skipped',reason:'busy'});
 assert.equal(calls,0);assert.equal(binding.release,undefined);
 const entry={id:'entry',type:'message'};session.sessionManager.getEntries=()=>[entry];
 const snapshot=await binding.snapshot();entry.id='later';
 assert.equal(snapshot.entries[0].id,'entry');assert.equal(snapshot.sessionId,idle.sessionId);
});

test('RPC uses existing demultiplexed public client and preserves ACK dispositions',async()=>{
 const calls=[];let disposition='handled';
 const client={getState:async()=>idle,getEntries:async()=>({entries:[],leafId:null}),prompt:async(...args)=>{calls.push(args);return disposition;}};
 const binding=createRpcHostBinding(client);
 for(const [mode,behavior]of [['native',undefined],['idle_only',undefined],['steer','steer'],['queue','followUp']]){
  assert.deepEqual(await binding.submit({text:'public',mode}),{status:'accepted',disposition,completion:'not_tracked'});
  assert.deepEqual(calls.at(-1),['public',undefined,behavior]);
  disposition='queued';
 }
 assert.equal(binding.release,undefined);assert.deepEqual(await binding.snapshot(),{sessionFile:idle.sessionFile,sessionId:idle.sessionId,entries:[],leafId:null});
});

test('RPC plain rejection or timeout errors cannot be misreported as definite rejection',async()=>{
 for(const message of ['PRIVATE_NEGATIVE_ACK','PRIVATE_TIMEOUT']){
  const binding=createRpcHostBinding({prompt:async()=>{throw new Error(message);}});
  const receipt=await binding.submit({text:'public'});
  assert.equal(receipt.status,'unknown');assert.equal(JSON.stringify(receipt).includes('PRIVATE'),false);
 }
});

test('RPC snapshot rejects session changes and observed busy prevents idle-only prompt',async()=>{
 let calls=0,reads=0;
 const binding=createRpcHostBinding({getState:async()=>({...idle,isStreaming:true,sessionId:++reads===1?'a':'b'}),getEntries:async()=>({entries:[],leafId:null}),prompt:async()=>{calls++;}});
 await assert.rejects(binding.snapshot(),/RUNTIME_SESSION_CHANGED/);
 assert.deepEqual(await binding.submit({text:'public',mode:'idle_only'}),{status:'skipped',reason:'busy'});assert.equal(calls,0);
});

test('release requires explicit host confirmation and waits tracked dispatched work',async()=>{
 const completion=Promise.withResolvers();let settled=false;
 const binding=createSdkHostBinding(sdk(()=>completion.promise),{release:async()=>({released:true})});
 await binding.submit({text:'public'});
 const releasing=binding.release().then(value=>{settled=true;return value;});
 await tick();assert.equal(settled,false);completion.resolve();await releasing;
 const unconfirmed=createSdkHostBinding(sdk(()=>{}),{release:async()=>({})});
 await assert.rejects(unconfirmed.release(),/HOST_RELEASE_UNCONFIRMED/);
});

test('SDK handled bash is recorded after stop; only fallback execution rechecks admission',async()=>{
 for(const handled of [true,false]){
  let stopping=false,recorded=0,captured=0;
  const result={output:'already executed by native hook',exitCode:0,cancelled:false,truncated:false};
  const session={sessionFile:'/synthetic/native.jsonl',sessionId:'native',sessionManager:{getCwd:()=>'/synthetic'},
   clearQueue:()=>({steering:[],followUp:[]}),abort:async()=>{},abortBash:()=>{},
   extensionRunner:{emitUserBash:async()=>{stopping=true;return handled?{result}:{};}},
   recordBashResult:()=>{recorded++;},executeBash:()=>assert.fail('stop forbids fallback execution')};
  const work=createSdkHostBinding(session).bash({command:'fixture',sessionFile:session.sessionFile,sessionId:session.sessionId,
   beforeDispatch:()=>{if(stopping)throw new Error('STOP_IN_PROGRESS');},onResult:async value=>{assert.deepEqual(value,{...result,fullOutputPath:null});captured++;}});
  if(handled){assert.equal((await work).completed,true);assert.equal(recorded,1);assert.equal(captured,1);}
  else{await assert.rejects(work,/STOP_IN_PROGRESS/);assert.equal(recorded,0);assert.equal(captured,0);}
 }
});
