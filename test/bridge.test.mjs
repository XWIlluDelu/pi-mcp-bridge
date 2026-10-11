import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Bridge } from '../src/bridge.mjs';
import { loadSavedSession } from '../src/data.mjs';
import { permitted } from '../src/permissions.mjs';
import { RpcFailure } from '../src/rpc.mjs';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('listing respects the latest native title including an explicit clear',async t=>{
 const f=await fixture(t),saved=await f.bridge.session(f.id),manager=SessionManager.open(saved.file);
 manager.appendSessionInfo(' OLD_TITLE ');
 assert.equal((await f.bridge.list()).sessions[0].title,manager.getSessionName());
 manager.appendSessionInfo('  ');
 assert.equal(manager.getSessionName(),undefined);
 assert.equal((await f.bridge.list()).sessions[0].title,null);
 assert.deepEqual((await f.bridge.list({query:'OLD_TITLE'})).sessions,[]);
});

async function fixture(t,grants,factory) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'pi-bridge-test-'));
  const cwd = path.join(dir,'project'), child = path.join(cwd,'child');
  await fs.mkdir(child,{recursive:true});
  const config = {principal:'test-caller',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd},{id:'child',path:child}],grants:grants?.(cwd,child) ?? [{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
  const runtime = {alive:true,calls:[],resumes:0,state:async()=>({isStreaming:false,isCompacting:false}),command:async function(c){this.calls.push(c);return {disposition:'started'};},stop:async function(){this.alive=false;}};
  const bridge = await new Bridge(config,factory ?? (async()=>{runtime.resumes++;runtime.alive=true;return runtime;})).init();
  t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
  const created = await bridge.create({folder_id:'project',request_id:'create-1'});
  return {bridge,config,dir,cwd,child,runtime,id:created.session_id,created};
}
async function append(f, entries) { const [s] = await f.bridge.sessions(); await fs.appendFile(s.file,entries.map(e=>JSON.stringify({timestamp:new Date().toISOString(),...e})).join('\n')+'\n'); return s.file; }

test('permissions: most specific, recent explicit field, unset inherits, final deny',()=>{
  const c={grants:[{folder:'/project',read:true,send:true},{folder:'/project/child',read:false},{folder:'/project',send:false},{session_id:'s',read:true},{session_id:'s',read:null}]};
  assert.equal(permitted(c,'read',{id:'s',cwd:'/project/child'}),false);
  assert.equal(permitted(c,'send',{id:'s',cwd:'/project/child'}),false);
  assert.equal(permitted(c,'read',{id:'other',cwd:'/project2'}),false);
  c.grants.push({session_id:'s',read:true}); assert.equal(permitted(c,'read',{id:'s',cwd:'/project/child'}),true);
  assert.equal(permitted(c,'delete',{id:'s',cwd:'/project'}),false);
});
test('create durable empty session; create allowed while send denied',async t=>{
  const f=await fixture(t,cwd=>[{folder:cwd,new_session:true,send:false}]);
  assert.equal(f.created.status,'created');
  const [s]=await f.bridge.sessions(); assert.equal((await loadSavedSession(s)).entries.length,0);
  assert.equal((await fs.readFile(s.file,'utf8')).trim().split('\n').length,1);
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'deny',text:'hello'})).status,'rejected');
});
test('no-read lists opaque ID only and cannot leak through search',async t=>{
  const f=await fixture(t,cwd=>[{folder:cwd,new_session:true,send:true}]);
  await append(f,[{type:'session_info',id:'title',parentId:null,name:'secret-project-name'}]);
  assert.deepEqual((await f.bridge.list()).sessions,[{session_id:f.id}]);
  assert.deepEqual((await f.bridge.list({query:'secret'})).sessions,[]);
  await assert.rejects(f.bridge.read({session_id:f.id}),/NOT_FOUND_OR_DENIED/);
  const receipt=await f.bridge.send({session_id:f.id,request_id:'send-only',text:'own-input'});
  assert.equal(receipt.status,'accepted'); assert.equal(JSON.stringify(receipt).includes('secret'),false);
});
test('saved idle_only resumes first; process reused',async t=>{
  const f=await fixture(t);
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'idle-1',text:'hello',mode:'idle_only'})).status,'accepted');
  await f.bridge.send({session_id:f.id,request_id:'idle-2',text:'again'});
  assert.equal(f.runtime.resumes,1); assert.equal(f.runtime.calls.length,2);
});
test('idle_only skips busy while native and strategy modes retain Pi semantics',async t=>{
  const f=await fixture(t); f.runtime.state=async()=>({isStreaming:true});
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'idle',text:'x',mode:'idle_only'})).status,'skipped');
  assert.equal(f.runtime.calls.length,0);
  await f.bridge.send({session_id:f.id,request_id:'native',text:'x',mode:'native'});
  await f.bridge.send({session_id:f.id,request_id:'steer',text:'x',mode:'steer'});
  await f.bridge.send({session_id:f.id,request_id:'queue',text:'x',mode:'queue'});
  assert.deepEqual(f.runtime.calls.map(c=>c.streamingBehavior),[undefined,'steer','followUp']);
});
test('concurrent same request_id sends once; new IDs do not content-dedupe',async t=>{
  const f=await fixture(t); const args={session_id:f.id,request_id:'same',text:'hello'};
  const r=await Promise.all(Array.from({length:10},()=>f.bridge.send(args)));
  assert.equal(f.runtime.calls.length,1); assert.deepEqual(r[0],r[9]);
  await assert.rejects(f.bridge.send({...args,text:'different'}),/REQUEST_ID_CONFLICT/);
  assert.deepEqual(await f.bridge.send({session_id:f.id,request_id:'same'}),r[0]);
  await f.bridge.send({...args,request_id:'another'}); assert.equal(f.runtime.calls.length,2);
});
test('unknown acceptance is journaled; retries never resend; late ACK repairs receipt',async t=>{
  const f=await fixture(t); let late;
  f.runtime.command=async(c,timeout,onLate)=>{f.runtime.calls.push(c);late=onLate;throw new RpcFailure('ACK_TIMEOUT',true);};
  const args={session_id:f.id,request_id:'timeout',text:'hello'};
  assert.equal((await f.bridge.send(args)).status,'unknown');
  assert.equal((await f.bridge.send(args)).status,'unknown'); assert.equal(f.runtime.calls.length,1);
  await late({ok:true,data:{disposition:'queued'}});
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'timeout'})).disposition,'queued');
});
test('context edits and branch selection; raw remains distinct; read does not write',async t=>{
  const f=await fixture(t);
  const file=await append(f,[
    {type:'message',id:'a',parentId:null,message:{role:'user',content:'original-secret'}},
    {type:'message',id:'abandoned',parentId:'a',message:{role:'user',content:'other-branch'}},
    {type:'context_edit',id:'edit',parentId:'a',targetId:'a',replacement:{content:'replacement'}},
  ]);
  const before=await fs.readFile(file,'utf8');
  const read=await f.bridge.read({session_id:f.id});
  assert.equal(read.items[0].message.content,'replacement');
  assert.equal(JSON.stringify(read).includes('original-secret'),false);assert.equal(JSON.stringify(read).includes('other-branch'),false);
  assert.equal((await f.bridge.read({session_id:f.id,view:'raw'})).items.length,3);
  assert.equal((await f.bridge.read({session_id:f.id,view:'raw',since:'a'})).items.length,2);
  await assert.rejects(f.bridge.read({session_id:f.id,leaf_id:'missing'}),/ENTRY_NOT_FOUND/);
  assert.equal(await fs.readFile(file,'utf8'),before);
});
test('compaction preserves checkpoint and kept context; existing summary only',async t=>{
  const f=await fixture(t);
  await append(f,[
    {type:'message',id:'a',parentId:null,message:{role:'user',content:'summarized-old'}},
    {type:'message',id:'b',parentId:'a',message:{role:'user',content:'kept'}},
    {type:'compaction',id:'c',parentId:'b',summary:'existing summary',firstKeptEntryId:'b',tokensBefore:10,systemMessage:{role:'system',content:'checkpoint'}},
  ]);
  const r=await f.bridge.read({session_id:f.id});
  assert.equal(r.items[0].message.role,'system');assert.equal(JSON.stringify(r).includes('summarized-old'),false);assert.equal(JSON.stringify(r).includes('kept'),true);
  assert.equal((await f.bridge.read({session_id:f.id,view:'summary'})).items[0].summary,'existing summary');
});
test('summaries follow the selected leaf and exclude superseded checkpoints retained in the raw range',async t=>{
  const f=await fixture(t);
  const file=await append(f,[
    {type:'message',id:'a',parentId:null,message:{role:'user',content:'old requirement'}},
    {type:'compaction',id:'c1',parentId:'a',summary:'old checkpoint',firstKeptEntryId:'a',tokensBefore:10},
    {type:'message',id:'b',parentId:'c1',message:{role:'user',content:'retained requirement'}},
    {type:'compaction',id:'c2',parentId:'b',summary:'new checkpoint',firstKeptEntryId:'c1',tokensBefore:20},
    {type:'message',id:'later',parentId:'c2',message:{role:'user',content:'newer decision after checkpoint'}},
  ]);
  const before=await fs.readFile(file,'utf8');
  const current=await f.bridge.read({session_id:f.id,view:'summary'});
  assert.deepEqual(current.items.map(x=>x.entry_id),['c2']);assert.equal(current.leaf_id,'later');
  assert.equal(current.items[0].summary,'new checkpoint'); // Not regenerated with the later decision.
  const context=await f.bridge.read({session_id:f.id,view:'context'});
  assert.deepEqual([...new Set(context.items.map(x=>x.entry_id))],['c2','b','later']);
  const earlier=await f.bridge.read({session_id:f.id,view:'summary',leaf_id:'b'});
  assert.deepEqual(earlier.items.map(x=>x.entry_id),['c1']);assert.equal(earlier.leaf_id,'b');
  assert.deepEqual((await f.bridge.read({session_id:f.id,view:'summary',leaf_id:null})).items,[]);
  assert.deepEqual((await f.bridge.read({session_id:f.id,view:'summary',entry_id:'c1'})).items,[]);
  const raw=await f.bridge.read({session_id:f.id,view:'raw',entry_id:'c2'});
  assert.equal(raw.items[0].entry.firstKeptEntryId,'c1');
  assert.equal((await f.bridge.read({session_id:f.id,view:'raw',entry_id:'c1'})).items[0].entry.summary,'old checkpoint');
  assert.equal(await fs.readFile(file,'utf8'),before);assert.equal(f.runtime.calls.length,0);
});
test('summaries omit a context-hidden branch summary but retain its original raw source',async t=>{
  const f=await fixture(t);
  await append(f,[
    {type:'message',id:'a',parentId:null,message:{role:'user',content:'public fixture'}},
    {type:'branch_summary',id:'branch',parentId:'a',fromId:'a',summary:'branch checkpoint'},
    {type:'context_edit',id:'hide',parentId:'branch',targetId:'branch',replacement:null},
  ]);
  assert.deepEqual((await f.bridge.read({session_id:f.id,view:'summary'})).items,[]);
  assert.deepEqual((await f.bridge.read({session_id:f.id,view:'summary',leaf_id:'branch'})).items,[{entry_id:'branch',type:'branch_summary',summary:'branch checkpoint'}]);
  assert.equal((await f.bridge.read({session_id:f.id,view:'raw',entry_id:'branch'})).items[0].entry.summary,'branch checkpoint');
});
test('selected context leaf metadata matches projected branch, including empty context',async t=>{
  const f=await fixture(t);
  await append(f,[{type:'message',id:'a',parentId:null,message:{role:'user',content:'branch-a'}},{type:'message',id:'b',parentId:null,message:{role:'user',content:'branch-b'}}]);
  const selected=await f.bridge.read({session_id:f.id,leaf_id:'a'});
  assert.equal(selected.leaf_id,'a');assert.equal(selected.items[0].message.content,'branch-a');
  assert.equal((await f.bridge.read({session_id:f.id,view:'summary',leaf_id:'a'})).leaf_id,'a');
  const empty=await f.bridge.read({session_id:f.id,leaf_id:null});assert.equal(empty.leaf_id,null);assert.deepEqual(empty.items,[]);
  assert.equal((await f.bridge.read({session_id:f.id,view:'raw'})).leaf_id,'b');
});
test('bounded oversized records can be reconstructed; stale cursors reject',async t=>{
  const f=await fixture(t); await append(f,[{type:'message',id:'big',parentId:null,message:{role:'user',content:'x'.repeat(2200)}}]);
  const args={session_id:f.id,max_chars:256};let r=await f.bridge.read(args),text='';const first=r.next_cursor;
  do {text+=r.items[0].json_fragment;r=r.next_cursor?await f.bridge.read({...args,cursor:r.next_cursor}):null;} while(r);
  assert.equal(JSON.parse(text).message.content.length,2200);
  await append(f,[{type:'message',id:'next',parentId:'big',message:{role:'user',content:'more'}}]);
  await assert.rejects(f.bridge.read({...args,cursor:first}),/STALE_CURSOR/);
});
test('delete stops active process, moves to recoverable trash, leaves project alone',async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.cwd,'keep.txt'),'untouched');
  await f.bridge.send({session_id:f.id,request_id:'send',text:'hello'});
  const r=await f.bridge.delete({session_id:f.id,request_id:'delete'});
  assert.equal(r.status,'deleted');assert.equal(f.runtime.alive,false);assert.equal((await f.bridge.list()).sessions.length,0);
  assert.equal(await fs.readFile(path.join(f.cwd,'keep.txt'),'utf8'),'untouched');
  const metadata=JSON.parse(await fs.readFile(path.join(f.config.stateDir,'trash',`${r.restore_token}.restore.json`),'utf8'));
  assert.ok((await fs.stat(metadata.trash_path)).size>0);
  assert.deepEqual(await f.bridge.delete({session_id:f.id,request_id:'delete'}),r);
  assert.equal(metadata.session_id,f.id);
  await fs.rename(metadata.trash_path,metadata.original_path);
  assert.equal((await f.bridge.list()).sessions[0].session_id,f.id);
});
test('create idempotence persists across a bridge restart',async t=>{
  const f=await fixture(t); await f.bridge.close(); const fresh=await new Bridge(f.config).init();
  try {
    assert.deepEqual(await fresh.create({folder_id:'project',request_id:'create-1'}),f.created);
    assert.equal((await fresh.list()).sessions.length,1);
  } finally { await fresh.close(); }
});

test('empty sessionRoots is rejected at startup instead of failing later during create',async t=>{
  const f=await fixture(t);
  const invalid=new Bridge({...f.config,stateDir:path.join(f.dir,'invalid-state'),sessionRoots:[]});
  await assert.rejects(invalid.init(),/INVALID_OWNER_CONFIG/);
  await assert.rejects(fs.stat(path.join(f.dir,'invalid-state')),{code:'ENOENT'});
});

test('changed native header identity produces a new opaque ID and cannot reuse old runtime',async t=>{
  const f=await fixture(t);
  await f.bridge.send({session_id:f.id,request_id:'original-send',text:'fixture'});
  assert.equal(f.runtime.resumes,1);
  const original=await f.bridge.session(f.id);
  await fs.writeFile(original.file,JSON.stringify({...original.header,id:'replacement-native-id'})+'\n');
  await assert.rejects(f.bridge.read({session_id:f.id}),/NOT_FOUND_OR_DENIED/);
  const rejected=await f.bridge.send({session_id:f.id,request_id:'old-send',text:'fixture'});
  assert.equal(rejected.status,'rejected');assert.equal(f.runtime.resumes,1);
  const [replacement]=(await f.bridge.list()).sessions;assert.notEqual(replacement.session_id,f.id);
  await f.bridge.send({session_id:replacement.session_id,request_id:'new-send',text:'fixture'});
  assert.equal(f.runtime.resumes,2);
});

test('project symlink cannot borrow lexical parent permissions',async t=>{
  const f=await fixture(t);const outside=path.join(f.dir,'outside');await fs.mkdir(outside);
  const link=path.join(f.cwd,'alias');await fs.symlink(outside,link,'dir');
  const [s]=await f.bridge.sessions();s.header.cwd=link;await fs.writeFile(s.file,JSON.stringify(s.header)+'\n');
  assert.deepEqual((await f.bridge.list()).sessions,[{session_id:f.id}]);
  assert.equal((await f.bridge.send({session_id:f.id,request_id:'symlink',text:'hello'})).status,'rejected');
});

test('invalid transcript trees retain identity but content reads reject',async t=>{
  const f=await fixture(t);const [s]=await f.bridge.sessions();
  await fs.appendFile(s.file,JSON.stringify({type:'message',id:'cycle',parentId:'cycle',message:{role:'user',content:'x'}})+'\n');
  assert.equal((await f.bridge.list()).sessions[0].session_id,f.id);
  await assert.rejects(f.bridge.read({session_id:f.id}),/INVALID_SESSION_TREE/);
});

test('oversized entry IDs cannot bypass read response bounds',async t=>{
  const f=await fixture(t);await append(f,[{type:'message',id:'x'.repeat(100000),parentId:null,message:{role:'user',content:'test'}}]);
  assert.equal((await f.bridge.list()).sessions[0].session_id,f.id);
  await assert.rejects(f.bridge.read({session_id:f.id}),/INVALID_SESSION_TREE/);
});

test('overlapping bridge state and session storage is rejected',async t=>{
  const f=await fixture(t);await f.bridge.close();
  f.config.stateDir=path.join(f.config.sessionRoots[0],'state');
  await assert.rejects(new Bridge(f.config).init(),/OVERLAPPING_STORAGE/);
});

test('shutdown stops admission and drains sends before closing owned runtime',async t=>{
  const f=await fixture(t);let unblock;const gate=new Promise(r=>{unblock=r;});
  const original=f.bridge.journal.put.bind(f.bridge.journal);let held=true;
  f.bridge.journal.put=async(...args)=>{if(held){held=false;await gate;}return original(...args);};
  const sending=f.bridge.send({session_id:f.id,request_id:'shutdown-race',text:'hello'});
  const closing=f.bridge.close();
  await assert.rejects(f.bridge.send({session_id:f.id,request_id:'late',text:'no'}),/BRIDGE_CLOSING/);
  unblock();await sending;await closing;
  assert.equal(f.runtime.alive,false);assert.equal(f.runtime.resumes,1);
});

test('delete preparation failure leaves an owned runtime alive and creates no restore intent',async t=>{
 const f=await fixture(t);await f.bridge.send({session_id:f.id,request_id:'start',text:'fixture'});
 await fs.mkdir(path.join(f.config.stateDir,'trash'),{mode:0o755});await fs.chmod(path.join(f.config.stateDir,'trash'),0o755);
 const result=await f.bridge.delete({session_id:f.id,request_id:'delete'});
 assert.equal(result.status,'rejected');assert.equal(f.runtime.alive,true);
 assert.deepEqual(await fs.readdir(path.join(f.config.stateDir,'trash')),[]);
 assert.deepEqual(await fs.readdir(path.join(f.config.sessionRoots[0],'.pi-mcp-trash')),[]);
 assert.equal((await f.bridge.list()).sessions.length,1);
});

test('delete rename failure cleans intents while post-move sync failure preserves recoverability',async t=>{
 for(const phase of ['rename','sync']){
  const f=await fixture(t),session=await f.bridge.session(f.id);let moved=false;
  const rename=fs.rename,open=fs.open;
  t.mock.method(fs,'rename',async(from,to)=>{
   if(from===session.file){if(phase==='rename')throw Object.assign(new Error('fixture'),{code:'EXDEV'});await rename(from,to);moved=true;return;}
   return rename(from,to);
  });
  t.mock.method(fs,'open',async(file,...args)=>{
   const fd=await open(file,...args);
   if(moved&&file===path.join(path.dirname(session.file),'.pi-mcp-trash'))fd.sync=async()=>{throw Object.assign(new Error('fixture'),{code:'EIO'});};
   return fd;
  });
  let result;try{result=await f.bridge.delete({session_id:f.id,request_id:'delete'});}finally{t.mock.restoreAll();}
  const intents=await fs.readdir(path.join(f.config.stateDir,'trash'));
  if(phase==='rename'){
   assert.equal(result.status,'rejected');assert.deepEqual(intents,[]);assert.ok(await fs.stat(session.file));
  }else{
   assert.equal(result.status,'unknown');assert.equal(intents.length,1);
   const metadata=JSON.parse(await fs.readFile(path.join(f.config.stateDir,'trash',intents[0]),'utf8'));
   assert.ok(await fs.stat(metadata.trash_path));assert.ok(await fs.stat(metadata.metadata_path));await assert.rejects(fs.stat(session.file),{code:'ENOENT'});
   assert.deepEqual(await f.bridge.delete({session_id:f.id,request_id:'delete'}),result);
  }
 }
});
