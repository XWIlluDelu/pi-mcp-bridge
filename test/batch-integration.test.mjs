import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const item=(op,args)=>({op,args});
test('mixed MCP batches operate on official Pi sessions, preserve restart receipts and isolate item permissions',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-batch-rpc-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'real-pi-faux-batch',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],piArgs:['-e',path.join(base,'research/faux-extension.mjs'),'--provider','bridge-fixture','--model','deterministic']};
 const filename=path.join(dir,'config.json');await fs.writeFile(filename,JSON.stringify(config));let client;
 async function connect(){client=new Client({name:'mixed-batch-fixture',version:'1.0.0'});await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:dir,PI_OFFLINE:'1'},stderr:'pipe'}));}
 async function call(name,args){const result=await client.callTool({name,arguments:args});assert.ok(!result.isError,`MCP ${name} failed`);return result.structuredContent;}
 try{
  await connect();
  const a=(await call('create',{folder_id:'project',request_id:'seed-a'})).session_id;
  const b=(await call('create',{folder_id:'project',request_id:'seed-b'})).session_id;
  const conflict=await call('batch',{operations:[item('create',{folder_id:'project',request_id:'must-not-create'}),item('delete',{session_id:a,request_id:'must-not-delete'}),item('send',{session_id:a,request_id:'must-not-send',text:'fixture'})]});
  assert.equal(conflict.status,'rejected');assert.equal(conflict.error.code,'DELETE_CONFLICT');assert.deepEqual(conflict.error.items,[1,2]);assert.equal((await call('list',{})).sessions.length,2);
  const invalid=await client.callTool({name:'batch',arguments:{operations:[item('create',{folder_id:'project',request_id:'also-must-not-create'}),item('read',{session_id:a,max_chars:1})]}});assert.equal(invalid.isError,true);assert.equal((await call('list',{})).sessions.length,2);
  const operations=[item('send',{session_id:a,request_id:'send-once',text:'PUBLIC_BATCH_FIXTURE'}),item('read',{session_id:a}),item('create',{folder_id:'project',request_id:'create-once'}),item('delete',{session_id:b,request_id:'delete-once'}),item('read',{session_id:'missing'}),item('create',{folder_id:'denied',request_id:'denied'})];
  const first=await call('batch',{operations});assert.equal(first.status,'processed');assert.equal(first.results[0].result.status,'accepted');assert.equal(first.results[0].result.disposition,'started');assert.ok(Array.isArray(first.results[1].result.items));assert.equal(first.results[2].result.status,'created');assert.equal(first.results[3].result.status,'deleted');assert.equal(first.results[4].error.code,'NOT_FOUND_OR_DENIED');assert.equal(first.results[5].result.status,'rejected');
  const c=first.results[2].result.session_id;
  let read;const deadline=Date.now()+10000;
  do{read=await call('read',{session_id:a});if(read.items.some(x=>x.message?.role==='assistant'))break;await new Promise(r=>setTimeout(r,50));}while(Date.now()<deadline);
  assert.equal(read.items.filter(x=>x.message?.role==='assistant').length,1);
  await client.close();await connect();
  const replay=await call('batch',{operations});for(const index of [0,2,3,5])assert.deepEqual(replay.results[index].result,first.results[index].result);
  read=await call('read',{session_id:a});assert.equal(read.items.filter(x=>x.message?.role==='assistant').length,1);assert.equal(JSON.stringify(read.items).split('PUBLIC_BATCH_FIXTURE').length-1,1);assert.equal((await call('list',{})).sessions.length,2);
  const multiple=await call('batch',{operations:[item('read',{session_id:a,view:'raw'}),item('read',{session_id:c,view:'context'})]});assert.equal(multiple.results[0].result.view,'raw');assert.deepEqual(multiple.results[1].result.items,[]);
  config.grants.push({session_id:a,read:false,send:true,delete:false});await fs.writeFile(filename,JSON.stringify(config));
  const independent=await call('batch',{operations:[item('read',{session_id:a}),item('send',{session_id:a,request_id:'send-only',text:'NO_RECEIPT_CONTENT'}),item('read',{session_id:c})]});assert.equal(independent.results[0].error.code,'NOT_FOUND_OR_DENIED');assert.equal(independent.results[1].result.status,'accepted');assert.ok(!JSON.stringify(independent.results[1]).includes('NO_RECEIPT_CONTENT'));assert.ok(!JSON.stringify(independent.results[1]).includes(cwd));assert.deepEqual(independent.results[2].result.items,[]);
  const removal=await call('batch',{operations:[item('delete',{session_id:a,request_id:'delete-denied'}),item('delete',{session_id:c,request_id:'delete-allowed'})]});assert.equal(removal.results[0].result.status,'rejected');assert.equal(removal.results[1].result.status,'deleted');
 }finally{await client?.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});}
});
