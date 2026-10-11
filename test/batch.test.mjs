import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { executeBatch,BATCH_RESPONSE_LIMIT } from '../src/batch.mjs';
import { Bridge } from '../src/bridge.mjs';
import { editPermission,readOwnerConfig } from '../src/owner-config.mjs';
const item=(op,args)=>({op,args});
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-batch-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'batch-test',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
 const bridge=await new Bridge(config).init();t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 return {bridge,config,dir,cwd};
}

test('batch validates every item and delete conflicts before any effects',async()=>{
 let calls=0;const bridge={create:async()=>{calls++;},read:async()=>{calls++;},delete:async()=>{calls++;}};
 for(const operations of [
  [item('create',{folder_id:'project',request_id:'first'}),item('send',{session_id:'s',request_id:'invalid space',text:'no'})],
  [item('create',{folder_id:'project',request_id:'first'}),item('delete',{session_id:'s',request_id:'delete'}),item('read',{session_id:'s'})],
  [item('send',{session_id:'s',request_id:'send',text:'no'}),item('delete',{session_id:'s',request_id:'delete'})],
  [item('create',{folder_id:'one',request_id:'duplicate'}),item('create',{folder_id:'two',request_id:'duplicate'})],
  [item('send',{session_id:'s',request_id:'duplicate',text:'first'}),item('send',{session_id:'s',request_id:'duplicate',text:'different'})],
  [item('send',{session_id:'s',request_id:'duplicate',text:'same',mode:'native'}),item('send',{session_id:'s',request_id:'duplicate',text:'same',mode:'queue'})],
  [item('read',{session_id:'s',leaf_id:'x'.repeat(6100001)})],
  Array.from({length:11},()=>item('read',{session_id:'s'})),
  [],
 ]){const result=await executeBatch(bridge,{operations});assert.equal(result.status,'rejected');assert.deepEqual(result.results,[]);}
 assert.equal(calls,0);
 const conflict=await executeBatch(bridge,{operations:[item('delete',{session_id:'s',request_id:'delete'}),item('read',{session_id:'s'})]});
 assert.deepEqual(conflict.error,{code:'DELETE_CONFLICT',items:[0,1],session_id:'s'});
});

test('batch runs in order, continues failures and never infers send completion',async()=>{
 const calls=[];let complete=false;
 const bridge={send:async()=>{calls.push('send');return {status:'accepted',disposition:'started',completion:'not_tracked'};},read:async()=>{calls.push('read');return {complete};},delete:async()=>{calls.push('delete');throw new Error('NOT_FOUND_OR_DENIED');},create:async()=>{calls.push('create');return {status:'created',session_id:'new'};}};
 const result=await executeBatch(bridge,{operations:[item('send',{session_id:'s',request_id:'send',text:'start'}),item('read',{session_id:'s'}),item('delete',{session_id:'other',request_id:'delete'}),item('create',{folder_id:'project',request_id:'create'})]});
 assert.deepEqual(calls,['send','read','delete','create']);assert.equal(result.status,'processed');assert.equal(result.results[1].result.complete,false);assert.equal(result.results[2].error.code,'NOT_FOUND_OR_DENIED');assert.equal(result.results[3].result.status,'created');
});

test('batch uses normal per-item permissions and durable request-ID replay',async t=>{
 const f=await fixture(t);const first=await f.bridge.create({folder_id:'project',request_id:'seed'});
 f.config.grants.push({session_id:first.session_id,read:false,delete:false});
 const operations=[item('read',{session_id:first.session_id}),item('delete',{session_id:first.session_id,request_id:'forbidden-delete'})];
 // Destructive conflict is rejected before either permission check or receipt write.
 assert.equal((await executeBatch(f.bridge,{operations})).status,'rejected');assert.equal(await f.bridge.journal.get('forbidden-delete'),null);
 const allowed=[item('create',{folder_id:'project',request_id:'new'}),item('read',{session_id:first.session_id}),item('create',{folder_id:'missing',request_id:'denied'}),item('create',{folder_id:'project',request_id:'new'})];
 const result=await executeBatch(f.bridge,{operations:allowed});assert.equal(result.results[0].result.status,'created');assert.equal(result.results[1].error.code,'NOT_FOUND_OR_DENIED');assert.equal(result.results[2].result.status,'rejected');assert.deepEqual(result.results[0].result,result.results[3].result);
 assert.deepEqual((await executeBatch(f.bridge,{operations:allowed})).results,result.results);
 assert.equal((await f.bridge.sessions()).length,2);
});

test('each batch item reloads permission edits instead of sharing an earlier grant',async t=>{
 const f=await fixture(t);await f.bridge.close();const file=path.join(f.dir,'config.json');await fs.writeFile(file,JSON.stringify(f.config));
 const bridge=await new Bridge(f.config,undefined,{configFile:file}).init();
 try{
  const create=bridge.create.bind(bridge);let count=0;
  bridge.create=async args=>{const result=await create(args);if(++count===1){const snapshot=await readOwnerConfig(file);await editPermission(file,snapshot.revision,{folder:f.cwd},'new_session',false);}return result;};
  const result=await executeBatch(bridge,{operations:[item('create',{folder_id:'project',request_id:'first'}),item('create',{folder_id:'project',request_id:'second'})]});
  assert.equal(result.results[0].result.status,'created');assert.equal(result.results[1].result.status,'rejected');assert.equal((await bridge.sessions()).length,1);
 }finally{await bridge.close();}
});

test('batch read budgets bound escaped persisted data and preserve usable cursors',async t=>{
 const f=await fixture(t);const made=await f.bridge.create({folder_id:'project',request_id:'seed'}),session=await f.bridge.session(made.session_id);
 await fs.appendFile(session.file,JSON.stringify({type:'message',id:'large',parentId:null,message:{role:'user',content:'"\\\n\t😀'.repeat(8000)}})+'\n');
 const args={session_id:made.session_id,view:'raw',max_chars:32768};
 const result=await executeBatch(f.bridge,{operations:Array.from({length:10},()=>item('read',args))});
 assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);assert.equal(result.results.length,10);
 for(const row of result.results){assert.ok(row.result.next_cursor);assert.ok(row.applied_max_chars<32768);const next=await f.bridge.read({...args,cursor:row.result.next_cursor});assert.ok(next.items[0].char_offset>0);}
});

test('exceptional oversized results are explicitly omitted without losing mutation replay guidance',async()=>{
 const result=await executeBatch({send:async()=>({status:'unknown',untrustedExtra:'x'.repeat(100000)})},{operations:[item('send',{session_id:'s',request_id:'id',text:'fixture'})]});
 assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);assert.deepEqual(result.results[0].error,{code:'BATCH_RESULT_OMITTED',retry:'SAME_REQUEST_ID'});
});
