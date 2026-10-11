import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { permitted } from '../src/permissions.mjs';
import { readOwnerConfig,editPermission,permissionDetails,validateGrants } from '../src/owner-config.mjs';
import ownerPermissions from '../src/owner-permissions-extension.mjs';
import { Bridge } from '../src/bridge.mjs';
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-perm-')),cwd=path.join(dir,'project'),child=path.join(cwd,'child');await fs.mkdir(child,{recursive:true});
 const file=path.join(dir,'owner.json');const config={principal:'test-agent',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd},{id:'child',path:child}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],unrelated:{preserve:['all','fields']}};
 await fs.writeFile(file,JSON.stringify(config));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return{dir,cwd,child,file,config};
}
test('grant scopes require exactly one present and valid scope field',()=>{
 for(const rule of [{},{session_id:17},{session_id:null},{session_id:''},{session_id:'x'.repeat(129)},{folder:17},{folder:null},{folder:''},{folder:'relative'},{session_id:'valid',folder:'/project'},{session_id:17,folder:'/project'},{session_id:null,folder:'/project'},{session_id:'',folder:'/project'},{session_id:'valid',folder:null},{session_id:'valid',folder:17},{session_id:'valid',folder:''}]){
  assert.throws(()=>validateGrants([{...rule,read:false}]),/INVALID_OWNER_CONFIG/);
 }
 assert.doesNotThrow(()=>validateGrants([{session_id:'valid',read:false},{folder:'/project',read:null}]));
});
test('live reload rejects malformed denial rather than silently retaining prior folder allowance',async t=>{
 const f=await fixture(t),bridge=await new Bridge(f.config,undefined,{configFile:f.file}).init();
 try{
  const made=await bridge.create({folder_id:'project',request_id:'scope-regression'});
  await bridge.read({session_id:made.session_id});
  for(const session_id of [17,null,'']){
   await fs.writeFile(f.file,JSON.stringify({...f.config,grants:[...f.config.grants,{session_id,folder:f.cwd,read:false}]}));
   await assert.rejects(bridge.read({session_id:made.session_id}),/INVALID_OWNER_CONFIG/);
  }
 }finally{await bridge.close();}
});
test('owner edits preserve unrelated config/rules and retain inheritance/null semantics',async t=>{
 const f=await fixture(t);let snapshot=await readOwnerConfig(f.file);
 snapshot=await editPermission(f.file,snapshot.revision,{folder:f.child},'read',false);
 assert.equal(permitted(snapshot.config,'read',{cwd:f.child}),false);assert.equal(permitted(snapshot.config,'send',{cwd:f.child}),true);
 snapshot=await editPermission(f.file,snapshot.revision,{session_id:'fixture-session'},'read',true);
 const target={session_id:'fixture-session',cwd:f.child};assert.equal(permissionDetails(snapshot.config,'read',target).source,'this session');
 snapshot=await editPermission(f.file,snapshot.revision,target,'read',null);
 assert.equal(permitted(snapshot.config,'read',{id:'fixture-session',cwd:f.child}),false);assert.equal(permissionDetails(snapshot.config,'read',target).allowed,false);
 snapshot=await editPermission(f.file,snapshot.revision,{folder:f.child},'read',null);
 assert.equal(permitted(snapshot.config,'read',{id:'fixture-session',cwd:f.child}),true);assert.ok(permissionDetails(snapshot.config,'read',target).source.includes(f.cwd));
 assert.deepEqual(snapshot.config.unrelated,f.config.unrelated);assert.deepEqual(snapshot.config.folders,f.config.folders);assert.deepEqual(snapshot.config.grants[0],f.config.grants[0]);
 await assert.rejects(editPermission(f.file,snapshot.revision,target,'new_session',true),/INVALID_PERMISSION_EDIT/);
});
test('owner edit refuses concurrent changes and writes only the selected permission',async t=>{
 const f=await fixture(t);const before=await readOwnerConfig(f.file);
 await fs.writeFile(f.file,JSON.stringify({...f.config,unrelated:{newValue:1}}));
 await assert.rejects(editPermission(f.file,before.revision,{folder:f.cwd},'send',false),/OWNER_CONFIG_CHANGED/);
 assert.deepEqual((await readOwnerConfig(f.file)).config.unrelated,{newValue:1});
});
test('permission menu registers only a human TUI shortcut and aborts on lifecycle change',async t=>{
 const f=await fixture(t),prior=process.env.PI_MCP_OWNER_CONFIG;process.env.PI_MCP_OWNER_CONFIG=f.file;
 const handlers={},shortcuts=[];const pi={on:(name,handler)=>{handlers[name]=handler;},registerShortcut:(key,options)=>shortcuts.push({key,...options}),registerCommand:()=>assert.fail('Permission command must not be remotely dispatchable'),registerTool:()=>assert.fail('No permission tool')};
 ownerPermissions(pi);assert.equal(shortcuts[0].key,'ctrl+alt+p');
 const ui={notify:()=>{},setStatus:()=>{},select:()=>assert.fail('Non-TUI menu must not open')};
 try{
  await shortcuts[0].handler({mode:'rpc',hasUI:true,ui});
  const choices=['This project',0,'Block','Done'];
  const ctx={mode:'tui',hasUI:true,cwd:f.cwd,ui:{...ui,select:async(_title,options)=>{const value=choices.shift();return typeof value==='number'?options[value]:value;}}};
  handlers.session_start({},ctx);await shortcuts[0].handler(ctx);
  assert.equal(permitted((await readOwnerConfig(f.file)).config,'read',{cwd:f.cwd}),false);
  ctx.ui.select=async()=>{handlers.session_shutdown();return 'This project';};
  const unchanged=await fs.readFile(f.file,'utf8');await shortcuts[0].handler(ctx);assert.equal(await fs.readFile(f.file,'utf8'),unchanged);
 }finally{if(prior===undefined)delete process.env.PI_MCP_OWNER_CONFIG;else process.env.PI_MCP_OWNER_CONFIG=prior;}
});
test('running bridge reloads only valid permission edits and fails closed on other changes',async t=>{
 const f=await fixture(t);const bridge=await new Bridge(f.config,undefined,{configFile:f.file}).init();
 try{
  const made=await bridge.create({folder_id:'project',request_id:'create'});let snapshot=await readOwnerConfig(f.file);
  await editPermission(f.file,snapshot.revision,{session_id:made.session_id},'read',false);
  assert.deepEqual((await bridge.list()).sessions,[{session_id:made.session_id}]);await assert.rejects(bridge.read({session_id:made.session_id}),/NOT_FOUND_OR_DENIED/);
  await fs.writeFile(f.file,JSON.stringify({...f.config,principal:'changed-principal'}));await assert.rejects(bridge.list(),/CONFIG_RESTART_REQUIRED/);
  await fs.writeFile(f.file,'broken');await assert.rejects(bridge.list(),/INVALID_OWNER_CONFIG/);
 }finally{await bridge.close();}
});

test('shutdown prevents dispatch after an asynchronous permission reload',async t=>{
 const f=await fixture(t);const bridge=await new Bridge(f.config,undefined,{configFile:f.file}).init();
 const made=await bridge.create({folder_id:'project',request_id:'create'});
 const send=bridge.send({session_id:made.session_id,request_id:'closing',text:'must not dispatch'});const closed=bridge.close();
 await assert.rejects(send,/BRIDGE_CLOSING/);await closed;assert.equal(bridge.pool.instances.size,0);
});
