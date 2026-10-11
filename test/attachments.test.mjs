import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import { AttachedRuntime, readClaim, reserveOwner, updateOwner, releaseOwner, processIdentity, ownerAlive, privateDirectory, waitOwnerExit } from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';
import { operationSchemas } from '../src/tool-schemas.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-at-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'attached-test',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],attachmentDir:path.join(dir,'ipc'),attachmentExitTimeoutMs:4000};
 const bridge=await new Bridge(config).init();const made=await bridge.create({folder_id:'project',request_id:'create'});const session=await bridge.session(made.session_id);
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,cwd,config,bridge,session,id:made.session_id};
}
async function until(fn,timeout=12000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(e){last=e;}await new Promise(r=>setTimeout(r,30));}throw last??new Error('Fixture deadline');}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
async function tui(t,f,{expectFailure=false}={}){
 const agentDir=path.join(f.dir,'agent');await fs.mkdir(agentDir);
 await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
 const commands=path.join(f.dir,'commands.mjs');
 await fs.writeFile(commands,`export default function(pi){pi.registerCommand('fixture-reload',{handler:async(_a,ctx)=>{await ctx.reload();}});pi.registerCommand('fixture-switch',{handler:async(_a,ctx)=>{await ctx.newSession({setup:async manager=>{manager.appendMessage({role:'user',content:'replacement public fixture',timestamp:Date.now()});}});}});pi.registerCommand('fixture-fork',{handler:async(_a,ctx)=>{await ctx.fork(ctx.sessionManager.getEntries().find(e=>e.type==='message'&&e.message.role==='user').id,{position:'at'});}});pi.registerCommand('fixture-resume',{handler:async(args,ctx)=>{await ctx.switchSession(args.trim());}});}`);
 const args=[process.execPath,path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--session',f.session.file,'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','-e',path.join(base,'research/faux-extension.mjs'),'-e',path.join(base,'src/attach-extension.mjs'),'-e',commands,'--provider','bridge-fixture','--model','deterministic','--thinking','off'];
 const child=spawn('script',['-qefc',args.map(quote).join(' '),'/dev/null'],{cwd:f.cwd,env:{PATH:process.env.PATH,HOME:f.dir,PI_CODING_AGENT_DIR:agentDir,PI_MCP_ATTACH_DIR:f.config.attachmentDir,PI_OFFLINE:'1',TERM:'xterm-256color',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 let log='';child.stdout.on('data',chunk=>{log=(log+chunk.toString()).slice(-24000);});child.stderr.on('data',chunk=>{log=(log+chunk.toString()).slice(-24000);});
 let record;
 t.after(async()=>{
  // Test-owned TUI cleanup only; production attached deletion never sends OS signals.
  if(record&&await ownerAlive(record.owner))process.kill(record.owner.pid,'SIGTERM');
  child.stdin.destroy();if(child.exitCode===null)child.kill('SIGTERM');
 });
 if(expectFailure)return {child,getLog:()=>log};
 try{record=await until(async()=>{const r=await readClaim(f.config.attachmentDir,f.session);return r?.phase==='ready'?r:null;});}catch(e){throw new Error('TUI startup failed: '+log.slice(-3000),{cause:e});}
 return {child,record,getLog:()=>log};
}

test('private registry rejects group-readable directory and live owner prevents RPC fallback',async t=>{
 const f=await fixture(t);const record=await reserveOwner(f.config.attachmentDir,f.session,'tui');
 const sent=await f.bridge.send({session_id:f.id,request_id:'blocked',text:'never dispatch'});
 assert.equal(sent.status,'rejected');assert.equal(sent.reason,'LIVE_OWNER_UNREACHABLE');assert.equal(f.bridge.pool.instances.size,0);
 await assert.rejects(f.bridge.read({session_id:f.id}),/LIVE_OWNER_UNREACHABLE/);
 await assert.rejects(reserveOwner(f.config.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
 await releaseOwner(f.config.attachmentDir,f.session,record);
 const bad=path.join(f.dir,'bad');await fs.mkdir(bad);await fs.chmod(bad,0o755);await assert.rejects(privateDirectory(bad),/INVALID_ATTACHMENT_DIRECTORY/);
});

test('overlong attachment path prevents bridge startup and official TUI exits on registration failure',async t=>{
 const f=await fixture(t);await f.bridge.close();
 f.config.attachmentDir=path.join(f.dir,'x'.repeat(80));
 await assert.rejects(new Bridge(f.config).init(),/ATTACHMENT_SOCKET_PATH_TOO_LONG/);
 const launched=await tui(t,f,{expectFailure:true});
 await until(()=>launched.child.exitCode!==null);
 assert.ok(launched.getLog().includes('ATTACHMENT_SOCKET_PATH_TOO_LONG'));
 assert.ok(await fs.stat(f.session.file));
 assert.equal(f.bridge.pool.instances.size,0);
});

test('attached shutdown acknowledgment is insufficient until exact owner process exits',async t=>{
 const f=await fixture(t);const record=await reserveOwner(f.config.attachmentDir,f.session,'tui');
 const server=net.createServer(socket=>socket.once('data',()=>socket.end(JSON.stringify({generation:record.generation,data:{shutdown:'requested'}})+'\n')));
 await new Promise(r=>server.listen(record.socket,r));t.after(()=>new Promise(r=>server.close(r)));
 await updateOwner(f.config.attachmentDir,f.session,record,{phase:'ready'});
 const runtime=new AttachedRuntime({...f.config,attachmentExitTimeoutMs:40},f.session,record);
 await assert.rejects(runtime.stopForDelete(),/OWNER_STILL_ALIVE/);assert.equal(await ownerAlive(record.owner),true);assert.ok(await fs.stat(f.session.file));
 await runtime.stop();assert.equal(await ownerAlive(record.owner),true);
});

test('conclusively dead registered owner permits claimed RPC fallback without a model call',async t=>{
 const f=await fixture(t);
 await reserveOwner(f.config.attachmentDir,f.session,'tui',{pid:process.pid,start:'0',boot:'expired-boot'});
 const runtime=await f.bridge.pool.resolve(f.session);assert.equal(runtime.attached,undefined);
 assert.equal((await runtime.state()).sessionId,f.session.header.id);
 const claim=await readClaim(f.config.attachmentDir,f.session);assert.equal(claim.kind,'rpc');assert.equal(await ownerAlive(claim.owner),true);
 await f.bridge.close();assert.equal(await readClaim(f.config.attachmentDir,f.session),null);
});

test('deletion holds a cooperative claim until the caller finishes the filesystem move',async t=>{
 const f=await fixture(t);const release=await f.bridge.pool.stopForDelete(f.session);
 await assert.rejects(reserveOwner(f.config.attachmentDir,f.session,'tui'),/LIVE_OWNER_UNREACHABLE/);
 await release();const owner=await reserveOwner(f.config.attachmentDir,f.session,'tui');await releaseOwner(f.config.attachmentDir,f.session,owner);
});

test('attachment deletion timeout is a bounded owner setting',async t=>{
 const f=await fixture(t);
 for(const attachmentExitTimeoutMs of ['5000',0,30001,Infinity])await assert.rejects(new Bridge({...f.config,attachmentExitTimeoutMs}).init(),/INVALID_OWNER_CONFIG/);
});

test('extension uses public dispatch flags, truthful unknown receipts, and idle includes compaction',async t=>{
 const f=await fixture(t);const original=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={},calls=[];let idle=true,shutdown=false,leaf='b';
 const pi={on:(name,fn)=>{handlers[name]=fn;},sendUserMessage:(text,options)=>calls.push({text,options})};
 attachExtension(pi);
 const entries=[{type:'message',id:'a',parentId:null,message:{role:'user',content:'a'.repeat(600)}},{type:'message',id:'b',parentId:null,message:{role:'user',content:'b'.repeat(600)}}];
 const ctx={mode:'tui',sessionManager:{getSessionFile:()=>f.session.file,getHeader:()=>f.session.header,getSessionId:()=>f.session.header.id,getEntries:()=>entries,getLeafId:()=>leaf},isIdle:()=>idle,shutdown:()=>{shutdown=true;}};
 try{
  await handlers.session_start({reason:'startup'},ctx);const record=await readClaim(f.config.attachmentDir,f.session);const runtime=new AttachedRuntime(f.config,f.session,record);
  for(const mode of ['native','idle_only','steer','queue']){
   const result=await runtime.send({text:'public fixture',mode});assert.equal(result.status,'unknown');assert.equal(result.dispatch,'submitted');assert.equal(result.reason,'PI_ACCEPTANCE_UNOBSERVABLE');
  }
  assert.deepEqual(calls.map(x=>x.options),[{expandPromptTemplates:true},{expandPromptTemplates:true},{expandPromptTemplates:true,deliverAs:'steer'},{expandPromptTemplates:true,deliverAs:'followUp'}]);
  idle=false;assert.equal((await runtime.send({text:'compacting',mode:'idle_only'})).status,'skipped');assert.equal(calls.length,4);
  const escaped={session_id:f.id,request_id:'escaped',text:'\0'.repeat(100000),mode:'native'};
  assert.equal(operationSchemas.send.safeParse(escaped).success,true);
  assert.equal((await runtime.send(escaped)).dispatch,'submitted');assert.equal(calls.at(-1).text,escaped.text);
  f.bridge.pool.instances.set(f.id,runtime);
  const connect=t.mock.method(net,'createConnection',()=>{throw new Error('oversized requests must not connect');});
  try{
   const rejected=await f.bridge.send({...escaped,request_id:'oversized',text:'\0'.repeat(200000)});
   assert.equal(rejected.status,'rejected');assert.equal(rejected.reason,'ATTACHMENT_REQUEST_TOO_LARGE');assert.equal(connect.mock.calls.length,0);
  }finally{connect.mock.restore();}
  const page=await runtime.read({session_id:f.id,max_chars:256});assert.ok(page.next_cursor);leaf='a';
  await assert.rejects(runtime.read({session_id:f.id,max_chars:256,cursor:page.next_cursor}),/STALE_CURSOR/);
  await runtime.stop();assert.equal(shutdown,false);
  await handlers.session_shutdown({reason:'reload'},ctx);
  assert.equal((await readClaim(f.config.attachmentDir,f.session)).phase,'transitioning');
  await assert.rejects(reserveOwner(f.config.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
  await handlers.session_start({reason:'reload'},ctx);
  assert.notEqual((await readClaim(f.config.attachmentDir,f.session)).generation,record.generation);
 }finally{await handlers.session_shutdown({reason:'quit'},ctx);if(original===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=original;}
});

test('same session continues headless after actual TUI exit with history, grants, profile and restart receipt intact',async t=>{
 const f=await fixture(t),profile=path.join(f.dir,'headless-marker.mjs');
 await fs.writeFile(profile,"export default function(pi){pi.on('session_start',()=>pi.appendEntry('headless-profile',{fixture:true}));}");
 f.config.piArgs=['-e',path.join(base,'research/faux-extension.mjs'),'-e',profile,'--provider','bridge-fixture','--model','deterministic','--thinking','off'];
 const launched=await tui(t,f);const first=await f.bridge.send({session_id:f.id,request_id:'tui-history',text:'PUBLIC_TUI_HISTORY'});assert.equal(first.dispatch,'submitted');
 await until(async()=>{const r=await f.bridge.read({session_id:f.id});return r.items.some(x=>x.message?.role==='assistant')&&!(await f.bridge.pool.get(f.id).state()).isStreaming;});
 process.kill(launched.record.owner.pid,'SIGTERM');await waitOwnerExit(launched.record.owner);
 assert.equal((await f.bridge.session(f.id)).file,f.session.file);
 f.config.grants.push({session_id:f.id,send:false});assert.equal((await f.bridge.send({session_id:f.id,request_id:'denied-after-tui',text:'MUST_NOT_DISPATCH'})).status,'rejected');
 const afterDenial=await readClaim(f.config.attachmentDir,f.session);assert.ok(!afterDenial||!(await ownerAlive(afterDenial.owner)));
 f.config.grants.push({session_id:f.id,send:true});
 const second=await f.bridge.send({session_id:f.id,request_id:'headless-same-session',text:'PUBLIC_HEADLESS_CONTINUATION',mode:'idle_only'});assert.equal(second.status,'accepted');assert.equal(second.disposition,'started');
 const claim=await readClaim(f.config.attachmentDir,f.session);assert.equal(claim.kind,'rpc');assert.equal(claim.sessionId,f.session.header.id);assert.equal(await ownerAlive(claim.owner),true);assert.notEqual(claim.generation,launched.record.generation);assert.equal(f.bridge.pool.instances.size,1);
 await until(async()=>{const r=await f.bridge.read({session_id:f.id});return r.items.filter(x=>x.message?.role==='assistant').length===2;});
 const raw=await f.bridge.read({session_id:f.id,view:'raw',limit:50,max_chars:32768});assert.ok(raw.items.some(x=>x.entry.customType==='headless-profile'));
 const history=JSON.stringify(raw);assert.ok(history.includes('PUBLIC_TUI_HISTORY'));assert.ok(history.includes('PUBLIC_HEADLESS_CONTINUATION'));assert.ok(!history.includes('MUST_NOT_DISPATCH'));
 await f.bridge.close();assert.equal(await ownerAlive(claim.owner),false);
 const restarted=await new Bridge(f.config).init();try{
  assert.deepEqual(await restarted.send({session_id:f.id,request_id:'headless-same-session'}),second);assert.deepEqual(await restarted.send({session_id:f.id,request_id:'denied-after-tui'}),{request_id:'denied-after-tui',operation:'send',status:'rejected',reason:'NOT_FOUND_OR_DENIED'});
  assert.equal(restarted.pool.instances.size,0);assert.equal(await readClaim(f.config.attachmentDir,f.session),null);
  const read=await restarted.read({session_id:f.id,view:'raw',limit:50,max_chars:32768});assert.deepEqual(read.items,raw.items);
 }finally{await restarted.close();}
});

test('official offline Pi TUI attaches, sends all modes, reloads, resumes attachment and deletes after exit',async t=>{
 const f=await fixture(t);const launched=await tui(t,f);
 const receipt=await f.bridge.send({session_id:f.id,request_id:'native',text:'first public fixture',mode:'native'});
 assert.equal(receipt.status,'unknown');assert.equal(receipt.dispatch,'submitted');
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'idle-skip',text:'must skip',mode:'idle_only'})).status,'skipped');
 for(const mode of ['native','steer','queue']){
  const r=await f.bridge.send({session_id:f.id,request_id:'busy-'+mode,text:'busy '+mode,mode});assert.equal(r.status,'unknown');assert.equal(r.dispatch,'submitted');
 }
 assert.deepEqual(await f.bridge.send({session_id:f.id,request_id:'native'}),receipt);
 await until(async()=>{const r=await f.bridge.read({session_id:f.id,max_chars:32768,limit:50});return r.items.filter(x=>x.message?.role==='assistant').length>=3;});
 assert.equal(f.bridge.pool.get(f.id).attached,true);
 for(const mode of ['idle_only','steer','queue']){
  const r=await f.bridge.send({session_id:f.id,request_id:'idle-'+mode,text:'idle '+mode,mode});assert.equal(r.status,'unknown');await until(async()=>!(await f.bridge.pool.get(f.id).state()).isStreaming);
 }
 const raw=await f.bridge.read({session_id:f.id,view:'raw',max_chars:256});assert.ok(raw.next_cursor);
 assert.equal(JSON.stringify(await f.bridge.read({session_id:f.id,view:'raw',max_chars:32768,limit:50})).includes('must skip'),false);
 const oldGeneration=launched.record.generation;
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'reload',text:'/fixture-reload'})).status,'unknown');
 await until(async()=>{const r=await readClaim(f.config.attachmentDir,f.session);return r?.phase==='ready'&&r.generation!==oldGeneration;});
 await assert.rejects(f.bridge.read({session_id:f.id,view:'raw',max_chars:256,cursor:raw.next_cursor}),/STALE_CURSOR/);
 await f.bridge.close();assert.equal(await ownerAlive(launched.record.owner),true);
 const restarted=await new Bridge(f.config).init();t.after(()=>restarted.close());
 assert.deepEqual(await restarted.send({session_id:f.id,request_id:'native'}),receipt);
 assert.ok((await restarted.read({session_id:f.id})).items.length>0);
 const removed=await restarted.delete({session_id:f.id,request_id:'delete'});assert.equal(removed.status,'deleted');assert.equal(await ownerAlive(launched.record.owner),false);
 assert.equal((await restarted.list()).sessions.length,0);
 await restarted.close();
});

test('delayed shutdown flush cannot call a replaced or invalidated Pi context',async t=>{
 const f=await fixture(t),previous=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={},callbacks=[];let shutdowns=0;
 attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
 const originalEnd=net.Socket.prototype.end;
 t.mock.method(net.Socket.prototype,'end',function(...args){
  if(typeof args[0]==='string'&&args[0].includes('"shutdown":"requested"')&&typeof args[1]==='function'){
   callbacks.push(args[1]);args.splice(1,1);
  }
  return originalEnd.apply(this,args);
 });
 const context=()=>{
  const state={valid:true};
  const check=()=>{if(!state.valid)throw new Error('Pi extension context is no longer active');};
  const ctx={mode:'tui',sessionManager:{getSessionFile:()=>{check();return f.session.file;},getHeader:()=>f.session.header,getSessionId:()=>{check();return f.session.header.id;}},shutdown:()=>{check();shutdowns++;}};
  return {state,ctx};
 };
 let current=context();
 try{
  await handlers.session_start({reason:'startup'},current.ctx);
  let runtime=new AttachedRuntime(f.config,f.session,await readClaim(f.config.attachmentDir,f.session));
  assert.equal((await runtime.request('shutdown')).shutdown,'requested');assert.equal(callbacks.length,1);
  await handlers.session_shutdown({reason:'reload'},current.ctx);current.state.valid=false;
  current=context();await handlers.session_start({reason:'reload'},current.ctx);
  assert.doesNotThrow(()=>callbacks.shift()());assert.equal(shutdowns,0);
  runtime=new AttachedRuntime(f.config,f.session,await readClaim(f.config.attachmentDir,f.session));
  await runtime.request('shutdown');current.state.valid=false;
  assert.doesNotThrow(()=>callbacks.shift()());assert.equal(shutdowns,0);
  current.state.valid=true;await runtime.request('shutdown');callbacks.shift()();assert.equal(shutdowns,1);
 }finally{
  await handlers.session_shutdown({reason:'quit'},current.ctx);t.mock.restoreAll();
  if(previous===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=previous;
 }
});

test('registry failure during shutdown still closes old socket and retains blocking ownership',async t=>{
 const f=await fixture(t),previous=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={};attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
 const ctx={mode:'tui',sessionManager:{getSessionFile:()=>f.session.file,getHeader:()=>f.session.header,getSessionId:()=>f.session.header.id}};
 const lock=path.join(f.config.attachmentDir,'registry.lock');
 try{
  await handlers.session_start({reason:'startup'},ctx);const record=await readClaim(f.config.attachmentDir,f.session);
  await fs.writeFile(lock,'simulated interrupted registry transaction',{mode:0o600});
  await assert.rejects(handlers.session_shutdown({reason:'reload'},ctx),/ATTACHMENT_REGISTRY_BUSY/);
  await assert.rejects(fs.stat(record.socket),{code:'ENOENT'});await fs.unlink(lock);
  assert.equal((await readClaim(f.config.attachmentDir,f.session)).generation,record.generation);
  assert.equal(await ownerAlive(record.owner),true);
  await assert.rejects(reserveOwner(f.config.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
 }finally{
  await fs.unlink(lock).catch(()=>{});await handlers.session_shutdown({reason:'quit'},ctx);
  if(previous===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=previous;
 }
});

test('socket startup failure retains live ownership and blocks both send fallback and deletion',async t=>{
 const f=await fixture(t),previous=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={};let shutdown=false;
 attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
 const ctx={mode:'tui',sessionManager:{getSessionFile:()=>f.session.file,getHeader:()=>f.session.header,getSessionId:()=>f.session.header.id},shutdown:()=>{shutdown=true;}};
 t.mock.method(net,'createServer',()=>{
  const server=new EventEmitter();server.listen=()=>queueMicrotask(()=>server.emit('error',new Error('injected listen failure')));server.close=done=>done();return server;
 });
 try{
  await assert.rejects(handlers.session_start({reason:'startup'},ctx),/injected listen failure/);
  assert.equal(shutdown,true);assert.equal((await readClaim(f.config.attachmentDir,f.session)).phase,'starting');
  const sent=await f.bridge.send({session_id:f.id,request_id:'failed-listen-send',text:'must not spawn'});
  assert.equal(sent.status,'rejected');assert.equal(sent.reason,'LIVE_OWNER_UNREACHABLE');
  const removed=await f.bridge.delete({session_id:f.id,request_id:'failed-listen-delete'});
  assert.equal(removed.status,'rejected');assert.equal(removed.reason,'LIVE_OWNER_UNREACHABLE');
  assert.ok(await fs.stat(f.session.file));assert.equal(f.bridge.pool.instances.size,0);
 }finally{
  await handlers.session_shutdown({reason:'quit'},ctx);t.mock.restoreAll();
  if(previous===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=previous;
 }
});

test('official TUI session replacement registers a fresh identity and socket loss does not spawn RPC',async t=>{
 const f=await fixture(t);const launched=await tui(t,f);
 await f.bridge.send({session_id:f.id,request_id:'fork-seed',text:'public fork fixture'});
 await until(async()=>(await f.bridge.read({session_id:f.id})).items.some(x=>x.message?.role==='assistant'));
 await until(async()=>!(await f.bridge.pool.get(f.id).state()).isStreaming);
 assert.equal((await f.bridge.send({session_id:f.id,request_id:'fork',text:'/fixture-fork'})).status,'unknown');
 const fork=await until(async()=>(await f.bridge.sessions()).find(s=>s.id!==f.id));
 const forkClaim=await until(async()=>{const r=await readClaim(f.config.attachmentDir,fork);return r?.phase==='ready'?r:null;});
 assert.notEqual(forkClaim.generation,launched.record.generation);
 // Ready publication precedes asynchronous old-claim cleanup. Await both
 // lifecycle conditions instead of assuming they are a single transaction.
 await until(async()=>await readClaim(f.config.attachmentDir,f.session)===null);
 assert.equal((await f.bridge.send({session_id:fork.id,request_id:'resume',text:'/fixture-resume '+f.session.file})).status,'unknown');
 const resumed=await until(async()=>{const r=await readClaim(f.config.attachmentDir,f.session);return r?.phase==='ready'&&r.generation!==launched.record.generation?r:null;});
 assert.notEqual(resumed.generation,forkClaim.generation);await until(async()=>await readClaim(f.config.attachmentDir,fork)===null);
 const sent=await f.bridge.send({session_id:f.id,request_id:'switch',text:'/fixture-switch'});assert.equal(sent.status,'unknown');
 const replacement=await until(async()=>{const sessions=await f.bridge.sessions();return sessions.find(s=>s.id!==f.id&&s.id!==fork.id);});
 const claim=await until(async()=>{const r=await readClaim(f.config.attachmentDir,replacement);return r?.phase==='ready'?r:null;});
 assert.notEqual(claim.generation,launched.record.generation);assert.notEqual(claim.sessionId,f.session.header.id);
 await until(async()=>await readClaim(f.config.attachmentDir,f.session)===null);
 const read=await f.bridge.read({session_id:replacement.id});assert.ok(JSON.stringify(read).includes('replacement public fixture'));
 await fs.unlink(claim.socket);
 const result=await f.bridge.send({session_id:replacement.id,request_id:'unreachable',text:'do not start a second process',timeout_ms:100});
 assert.equal(result.status,'rejected');assert.equal(result.reason,'LIVE_OWNER_UNREACHABLE');assert.equal(await ownerAlive(claim.owner),true);
 assert.equal(f.bridge.pool.get(replacement.id).attached,true);
 const removed=await f.bridge.delete({session_id:replacement.id,request_id:'blocked-delete'});assert.equal(removed.status,'rejected');assert.ok(await fs.stat(replacement.file));
});

test('standard MCP client attaches to an existing offline TUI through the single-operation tools alongside batch',async t=>{
 const f=await fixture(t);const launched=await tui(t,f);await f.bridge.close();
 const filename=path.join(f.dir,'config.json');await fs.writeFile(filename,JSON.stringify(f.config));
 const client=new Client({name:'attached-mcp-fixture',version:'1.0.0'});
 try{
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:f.dir,PI_OFFLINE:'1'},stderr:'pipe'}));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['batch','create','delete','list','read','send']);
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.ok(!result.isError);return result.structuredContent;};
  assert.equal((await call('list',{})).sessions[0].session_id,f.id);
  const receipt=await call('send',{session_id:f.id,request_id:'mcp-send',text:'offline MCP TUI fixture'});
  assert.equal(receipt.status,'unknown');assert.equal(receipt.reason,'PI_ACCEPTANCE_UNOBSERVABLE');
  assert.deepEqual(await call('send',{session_id:f.id,request_id:'mcp-send'}),receipt);
  await until(async()=>{const r=await call('read',{session_id:f.id});return r.items.some(x=>x.message?.role==='assistant');});
  const empty=await call('create',{folder_id:'project',request_id:'mcp-empty'});assert.equal(empty.status,'created');
  assert.equal((await call('delete',{session_id:empty.session_id,request_id:'mcp-delete-empty'})).status,'deleted');
  assert.equal((await call('delete',{session_id:f.id,request_id:'mcp-delete-tui'})).status,'deleted');
  assert.equal(await ownerAlive(launched.record.owner),false);
 }finally{await client.close();}
});
