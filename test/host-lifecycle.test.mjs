import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {Bridge} from '../src/bridge.mjs';
import {reserveHostSession} from '../src/host-adapter.mjs';
import {reserveOwner,releaseOwner,readClaim,ownerAlive} from '../src/attachments.mjs';
async function fixture(t){
 const dir=await fs.mkdtemp('/tmp/pi-host-life-'),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'fixture',stateDir:path.join(dir,'state'),attachmentDir:path.join(dir,'ipc'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'p',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}]};
 let spawns=0;const bridge=await new Bridge(config,async()=>{spawns++;throw Error('UNEXPECTED_SPAWN');}).init();
 const created=await bridge.create({folder_id:'p',request_id:'seed'}),session=await bridge.session(created.session_id);
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 return {dir,config,bridge,session,spawns:()=>spawns};
}
const identity=session=>({sessionFile:session.file,sessionId:session.header.id});
async function until(fn){const end=Date.now()+10000;while(Date.now()<end){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error('FIXTURE_TIMEOUT');}

test('a new owner in the release/reclaim gap blocks deletion without moving the file',async t=>{
 const f=await fixture(t),host=await reserveHostSession({attachmentDir:f.config.attachmentDir,session:f.session});
 const id=identity(f.session);
 await host.ready({state:async()=>id,snapshot:async()=>({...id,entries:[],leafId:null}),submit:async()=>({status:'unknown'}),release:async()=>({released:true})});
 let competitor;
 try{
  const runtime=await f.bridge.pool.forRead(f.session),stop=runtime.stopForDelete.bind(runtime);
  runtime.stopForDelete=async()=>{await stop();competitor=await reserveOwner(f.config.attachmentDir,f.session,'rpc');};
  const result=await f.bridge.delete({session_id:f.session.id,request_id:'delete'});
  assert.equal(result.status,'rejected');assert.equal(result.reason,'LIVE_OWNER_UNREACHABLE');
  assert.ok(await fs.stat(f.session.file));assert.equal((await readClaim(f.config.attachmentDir,f.session)).generation,competitor.generation);
  assert.deepEqual(await fs.readdir(path.join(f.config.stateDir,'trash')),[]);assert.equal(f.spawns(),0);
 }finally{if(competitor)await releaseOwner(f.config.attachmentDir,f.session,competitor);await host.close();}
});

test('controller death preserves the surviving writer claim and prevents bridge fallback',async t=>{
 const f=await fixture(t),marker=path.join(f.dir,'ready.json'),file=path.join(f.dir,'controller.json');
 await fs.writeFile(file,JSON.stringify({attachmentDir:f.config.attachmentDir,session:f.session,marker}));
 const controller=spawn(process.execPath,[fileURLToPath(new URL('./fixtures/host-controller.mjs',import.meta.url)),file],{stdio:'ignore'});
 const exited=new Promise(resolve=>controller.once('exit',resolve));let owner;
 try{
  ({owner}=await until(async()=>{try{return JSON.parse(await fs.readFile(marker,'utf8'));}catch{return null;}}));
  assert.equal((await f.bridge.read({session_id:f.session.id})).items.length,0);
  controller.kill('SIGKILL');await exited;
  assert.equal(await ownerAlive(owner),true);
  const claim=await readClaim(f.config.attachmentDir,f.session);assert.deepEqual(claim.owner,owner);
  await assert.rejects(f.bridge.read({session_id:f.session.id}),/LIVE_OWNER_UNREACHABLE/);
  const result=await f.bridge.send({session_id:f.session.id,request_id:'after-crash',text:'public fixture'});
  assert.equal(result.status,'rejected');assert.equal(result.reason,'LIVE_OWNER_UNREACHABLE');assert.equal(f.spawns(),0);
 }finally{
  if(controller.exitCode===null&&controller.signalCode===null){controller.kill('SIGKILL');await exited;}
  if(!owner){try{owner=(await readClaim(f.config.attachmentDir,f.session))?.owner;}catch{}}
  if(owner&&await ownerAlive(owner)){process.kill(owner.pid,'SIGTERM');await until(async()=>!await ownerAlive(owner));}
 }
});
