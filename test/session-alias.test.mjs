import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { discover, loadSession } from '../src/data.mjs';
import { reserveOwner, releaseOwner } from '../src/attachments.mjs';
import { PiRpc } from '../src/rpc.mjs';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readClaim, AttachedRuntime } from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-alias-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'alias-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],attachmentDir:path.join(dir,'ipc')};
 const bridge=await new Bridge(config).init();const created=await bridge.create({folder_id:'project',request_id:'seed'}),session=await bridge.session(created.session_id);
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,config,bridge,created,session};
}
test('hardlink aliases are hidden and stale discovered targets cannot claim or spawn',async t=>{
 const f=await fixture(t),alias=path.join(f.config.sessionRoots[0],'alias.jsonl');
 await fs.link(f.session.file,alias);
 assert.equal((await fs.stat(alias)).ino,(await fs.stat(f.session.file)).ino);
 assert.deepEqual(await discover(f.config),[]);
 for(const file of [f.session.file,alias]){
  await assert.rejects(loadSession(file),/SESSION_FILE_ALIAS_NOT_ALLOWED/);
  await assert.rejects(reserveOwner(f.config.attachmentDir,{...f.session,file},'rpc'),/SESSION_FILE_ALIAS_NOT_ALLOWED/);
  const rpc=new PiRpc(f.config,{...f.session,file});await assert.rejects(rpc.start(),/SESSION_FILE_ALIAS_NOT_ALLOWED/);assert.equal(rpc.child,undefined);
 }
 assert.deepEqual((await fs.readdir(f.config.attachmentDir)).filter(x=>x.endsWith('.owner.json')),[]);
 assert.deepEqual(await f.bridge.create({folder_id:'project',request_id:'seed'}),f.created); // Existing receipt contract unchanged.
 await fs.unlink(alias);
 assert.equal((await f.bridge.sessions())[0].id,f.session.id);
});
test('public identity remains path/header based across restart and same-header atomic replacement',async t=>{
 const f=await fixture(t),bytes=await fs.readFile(f.session.file),originalInode=(await fs.stat(f.session.file)).ino;
 const claim=await reserveOwner(f.config.attachmentDir,f.session,'rpc');
 const replacement=f.session.file+'.replacement';await fs.writeFile(replacement,bytes);await fs.rename(replacement,f.session.file);
 assert.notEqual((await fs.stat(f.session.file)).ino,originalInode);
 assert.equal((await f.bridge.sessions())[0].id,f.session.id);
 await assert.rejects(reserveOwner(f.config.attachmentDir,f.session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
 await releaseOwner(f.config.attachmentDir,f.session,claim);
 await f.bridge.close();
 const restarted=await new Bridge(f.config).init();try{assert.equal((await restarted.sessions())[0].id,f.session.id);}finally{await restarted.close();}
 const data=JSON.parse(bytes.toString().trim());data.id='40242f4e-1d23-4eba-bd14-367658ad8e44';await fs.writeFile(f.session.file,JSON.stringify(data)+'\n');
 assert.notEqual((await discover(f.config))[0].id,f.session.id);
});
test('TUI claim rejects hardlink and symlink aliases before publishing a record',async t=>{
 const f=await fixture(t),original=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 t.after(()=>{if(original===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=original;});
 const hardlink=path.join(f.dir,'hard.jsonl'),symlink=path.join(f.dir,'sym.jsonl');
 await fs.link(f.session.file,hardlink);await fs.symlink(f.session.file,symlink);
 for(const file of [f.session.file,hardlink,symlink]){
  const handlers={};let shutdown=false;
  attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
  const ctx={mode:'tui',sessionManager:{getSessionFile:()=>file,getHeader:()=>f.session.header},shutdown:()=>{shutdown=true;}};
  await assert.rejects(handlers.session_start({},ctx),/SESSION_FILE_ALIAS_NOT_ALLOWED/);assert.equal(shutdown,true);
 }
 assert.deepEqual((await fs.readdir(f.config.attachmentDir)).filter(x=>x.endsWith('.owner.json')),[]);
});

test('native unflushed startup and /new reserve their paths and validate after persistence',async t=>{
 const f=await fixture(t),original=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={};let stopped=false;
 attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
 const context=manager=>({mode:'tui',sessionManager:manager,isIdle:()=>true,shutdown:()=>{stopped=true;}});
 try{
  for(const reason of ['startup','new']){
   if(reason==='new')await handlers.session_shutdown({reason:'new'});
   const manager=SessionManager.create(f.dir,f.config.sessionRoots[0]),file=manager.getSessionFile();
   await assert.rejects(fs.stat(file),{code:'ENOENT'});
   await handlers.session_start({reason},context(manager));assert.equal(stopped,false);
   const session={file,header:manager.getHeader()},claim=await readClaim(f.config.attachmentDir,session);
   assert.equal(claim.phase,'ready');
   const runtime=new AttachedRuntime(f.config,session,claim);assert.equal((await runtime.state()).sessionId,session.header.id);
   manager.appendMessage({role:'user',content:'native persistence fixture',timestamp:Date.now()});
   await handlers.agent_settled();
   assert.equal((await runtime.read({session_id:'fixture',view:'raw'})).items.length,1);
   await assert.rejects(reserveOwner(f.config.attachmentDir,session,'rpc'),/LIVE_OWNER_UNREACHABLE/);
   if(reason==='new'){
    const alias=path.join(f.dir,'new-alias.jsonl');await fs.link(file,alias);
    await assert.rejects(runtime.state());assert.equal(stopped,true);
    assert.equal((await readClaim(f.config.attachmentDir,session)).generation,claim.generation);
   }
  }
 }finally{
  await handlers.session_shutdown({reason:'quit'});
  if(original===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=original;
 }
});
test('missing targets do not bypass canonical parent or observed-file checks',async t=>{
 const f=await fixture(t),original=process.env.PI_MCP_ATTACH_DIR;process.env.PI_MCP_ATTACH_DIR=f.config.attachmentDir;
 const handlers={};let stopped=false;attachExtension({on:(name,fn)=>{handlers[name]=fn;}});
 const manager=SessionManager.create(f.dir,f.config.sessionRoots[0]),file=manager.getSessionFile();
 const parentAlias=path.join(f.dir,'root-alias');await fs.symlink(f.config.sessionRoots[0],parentAlias);
 try{
  await assert.rejects(handlers.session_start({reason:'startup'},{mode:'tui',sessionManager:{getSessionFile:()=>path.join(parentAlias,path.basename(file)),getHeader:()=>manager.getHeader()},shutdown:()=>{}}),/SESSION_FILE_ALIAS_NOT_ALLOWED/);
  const ctx={mode:'tui',sessionManager:manager,isIdle:()=>true,shutdown:()=>{stopped=true;}};
  await handlers.session_start({reason:'startup'},ctx);
  manager.appendMessage({role:'user',content:'persist then remove fixture',timestamp:Date.now()});await handlers.agent_settled();
  await fs.unlink(file);
  await assert.rejects(handlers.agent_settled(),{code:'ENOENT'});assert.equal(stopped,true);
 }finally{
  await handlers.session_shutdown({reason:'quit'});
  if(original===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=original;
 }
});
