import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Bridge } from '../src/bridge.mjs';
import { readClaim,ownerAlive,waitOwnerExit } from '../src/attachments.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label){const deadline=Date.now()+12000;while(Date.now()<deadline){if(await fn())return;await delay(25);}throw new Error('Deadline: '+label);}
test('human Pi menu changes live session/project permissions enforced by actual MCP and Pi runtimes',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-ui-'));const cwd=path.join(dir,'project'),childFolder=path.join(cwd,'child'),denied=path.join(dir,'denied');await fs.mkdir(childFolder,{recursive:true});await fs.mkdir(denied);
 const config={principal:'fixture-agent',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd},{id:'child',path:childFolder},{id:'denied',path:denied}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],attachmentDir:path.join(dir,'ipc'),piArgs:['-e',path.join(base,'research/faux-extension.mjs'),'--provider','bridge-fixture','--model','deterministic'],unrelated:{preserve:true}};
 const configFile=path.join(dir,'owner.json');await fs.writeFile(configFile,JSON.stringify(config));
 const setup=await new Bridge(config).init();const made=await setup.create({folder_id:'project',request_id:'seed'});const session=await setup.session(made.session_id);await setup.close();
 const agentDir=path.join(dir,'agent');await fs.mkdir(agentDir);await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}));
 // Observe completion of our own shortcut handler through public registration;
 // do not replace Pi methods or treat a terminal redraw as callback completion.
 const menuObserver=path.join(dir,'menu-observer.mjs'),menuClosed=path.join(dir,'menu-closed.json');
 await fs.writeFile(menuObserver,`import fs from 'node:fs/promises';import ownerPermissions from ${JSON.stringify(path.join(base,'src/owner-permissions-extension.mjs'))};export default function(pi){let sequence=0;ownerPermissions({on:(...args)=>pi.on(...args),registerShortcut:(key,options)=>pi.registerShortcut(key,{...options,handler:async ctx=>{const invocation=++sequence;await options.handler(ctx);const file=${JSON.stringify(menuClosed)};await fs.writeFile(file+'.tmp',JSON.stringify({invocation}));await fs.rename(file+'.tmp',file);}})});}`);
 const args=[process.execPath,path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--session',session.file,'--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','-e',path.join(base,'research/faux-extension.mjs'),'-e',path.join(base,'src/attach-extension.mjs'),'-e',menuObserver,'--provider','bridge-fixture','--model','deterministic','--thinking','off'];
 const tui=spawn('script',['-qefc',args.map(quote).join(' '),'/dev/null'],{cwd,env:{PATH:process.env.PATH,HOME:dir,PI_CODING_AGENT_DIR:agentDir,PI_MCP_ATTACH_DIR:config.attachmentDir,PI_MCP_OWNER_CONFIG:configFile,PI_OFFLINE:'1',TERM:'xterm-256color',LANG:'C.UTF-8'},stdio:['pipe','pipe','pipe']});
 const events=[];let failure,menuInvocation=0;
 const chunks=[];tui.stdout.on('data',chunk=>chunks.push(chunk.toString()));tui.stderr.on('data',chunk=>chunks.push(chunk.toString()));
 const client=new Client({name:'owner-ui-permission-fixture',version:'1.0.0'});let owner;
 const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});return result;};
 const ok=async(name,args)=>{const result=await call(name,args);assert.ok(!result.isError,`MCP ${name} failed`);return result.structuredContent;};
 const key=async value=>{events.push({type:'key',time:Date.now(),value});tui.stdin.write(value);await delay(35);};
 async function screen(text,offset){await until(()=>chunks.slice(offset).join('').includes(text),'UI '+text);events.push({type:'screen',time:Date.now(),text,offset});}
 async function selectIndex(index){for(let i=0;i<index;i++)await key('\x1b[B');await key('\r');}
 async function edit(scope,action,value,expected,projectIndex=0){
  const invocation=++menuInvocation;events.push({type:'edit',time:Date.now(),invocation,scope,action,value});
  let offset=chunks.length;await key('\x1b\x10');await screen('MCP permissions',offset);offset=chunks.length;await selectIndex(scope);
  if(scope===2){await screen('Choose project',offset);offset=chunks.length;await selectIndex(projectIndex);}
  await screen('Read:',offset);offset=chunks.length;await selectIndex(action);await screen('Inherit',offset);
  offset=chunks.length;await selectIndex(value);await until(async()=>expected(JSON.parse(await fs.readFile(configFile,'utf8'))),'permission file edit');
  events.push({type:'config-visible',time:Date.now(),invocation});
  // Rename visibility is earlier than save completion and the next selector.
  await screen('Read:',offset);
  await selectIndex(scope===0?3:4);
  await until(async()=>{try{return JSON.parse(await fs.readFile(menuClosed,'utf8')).invocation===invocation;}catch(e){if(e.code==='ENOENT')return false;throw e;}},'permission handler closed');
  events.push({type:'closed',time:Date.now(),invocation});
 }
 try{
  await until(async()=>{owner=await readClaim(config.attachmentDir,session);return owner?.phase==='ready';},'TUI registration');
  await screen('Permissions: Ctrl+Alt+P',0);
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),configFile],cwd:base,env:{PATH:process.env.PATH,HOME:dir,PI_OFFLINE:'1'},stderr:'pipe'}));
  assert.deepEqual((await client.listTools()).tools.map(x=>x.name).sort(),['batch','create','delete','list','read','send']);
  const id=made.session_id;
  assert.equal((await ok('send',{session_id:id,request_id:'first',text:'PUBLIC_OWNER_SESSION_FIXTURE'})).status,'unknown');
  await until(async()=>(await ok('read',{session_id:id})).items.some(x=>x.message?.role==='assistant'),'actual TUI response');
  const sessionRule=c=>c.grants.findLast(r=>r.session_id===id);
  await edit(0,0,1,c=>sessionRule(c)?.read===false);
  assert.deepEqual((await ok('list',{})).sessions.find(x=>x.session_id===id),{session_id:id});
  assert.equal((await call('read',{session_id:id})).isError,true);
  assert.equal((await ok('list',{query:'PUBLIC_OWNER_SESSION_FIXTURE'})).sessions.length,0);
  const sendOnly=await ok('send',{session_id:id,request_id:'send-only',text:'PRIVATE_TO_CALLER_FIXTURE'});assert.equal(sendOnly.status,'unknown');assert.equal(sendOnly.dispatch,'submitted');assert.ok(!JSON.stringify(sendOnly).includes('PRIVATE_TO_CALLER_FIXTURE'));assert.ok(!JSON.stringify(sendOnly).includes(cwd));
  await edit(0,2,1,c=>sessionRule(c)?.delete===false);
  assert.equal((await ok('delete',{session_id:id,request_id:'deny-delete'})).status,'rejected');assert.equal(await ownerAlive(owner.owner),true);assert.ok(await fs.stat(session.file));
  await edit(0,1,1,c=>sessionRule(c)?.send===false);
  assert.equal((await ok('send',{session_id:id,request_id:'deny-send',text:'MUST_NOT_ENTER_SESSION'})).status,'rejected');
  assert.ok(!(await fs.readFile(session.file,'utf8')).includes('MUST_NOT_ENTER_SESSION'));
  await edit(0,0,0,c=>sessionRule(c)?.read===true);assert.ok((await ok('read',{session_id:id})).items.length>0);
  await edit(0,0,2,c=>sessionRule(c)?.read===null);assert.ok((await ok('read',{session_id:id})).items.length>0);
  await edit(1,1,1,c=>c.grants.findLast(r=>r.folder===cwd)?.send===false);
  await edit(0,1,2,c=>sessionRule(c)?.send===null);
  assert.equal((await ok('send',{session_id:id,request_id:'inherited-deny',text:'blocked by project'})).status,'rejected');
  await edit(1,3,1,c=>c.grants.findLast(r=>r.folder===cwd)?.new_session===false);
  assert.equal((await ok('create',{folder_id:'child',request_id:'new-session-denied'})).status,'rejected');
  await edit(1,3,0,c=>c.grants.findLast(r=>r.folder===cwd)?.new_session===true);
  const created=await ok('create',{folder_id:'child',request_id:'child-create'});assert.equal(created.status,'created');
  assert.equal((await ok('send',{session_id:created.session_id,request_id:'child-deny',text:'blocked inherited send'})).status,'rejected');
  assert.equal((await ok('create',{folder_id:'denied',request_id:'default-deny'})).status,'rejected');
  await edit(2,1,0,c=>c.grants.findLast(r=>r.folder===childFolder)?.send===true,1);
  assert.equal((await ok('send',{session_id:created.session_id,request_id:'child-allow',text:'child allowed public fixture'})).status,'accepted');
  await until(async()=>(await ok('read',{session_id:created.session_id})).items.some(x=>x.message?.role==='assistant'),'actual child RPC response');
  assert.equal((await ok('send',{session_id:id,request_id:'parent-still-denied',text:'parent denied'})).status,'rejected');
  assert.equal((await ok('delete',{session_id:created.session_id,request_id:'child-delete'})).status,'deleted');
  const finalConfig=JSON.parse(await fs.readFile(configFile,'utf8'));assert.deepEqual(finalConfig.unrelated,config.unrelated);assert.deepEqual(finalConfig.piArgs,config.piArgs);
  process.kill(owner.owner.pid,'SIGTERM');await waitOwnerExit(owner.owner);
  assert.ok((await ok('read',{session_id:id})).items.length>0);
  assert.equal((await ok('send',{session_id:id,request_id:'closed-ui-denied',text:'still denied after UI closes'})).status,'rejected');
  const headless=await ok('create',{folder_id:'child',request_id:'headless-create'});
  assert.equal((await ok('send',{session_id:headless.session_id,request_id:'headless-send',text:'public background fixture'})).status,'accepted');
  await until(async()=>(await ok('read',{session_id:headless.session_id})).items.some(x=>x.message?.role==='assistant'),'headless response after TUI exit');
  assert.equal((await ok('delete',{session_id:headless.session_id,request_id:'headless-delete'})).status,'deleted');
 }catch(error){
  failure=error;await fs.writeFile(path.join(dir,'terminal.txt'),chunks.join(''));await fs.writeFile(path.join(dir,'events.json'),JSON.stringify(events,null,2));
  error.message+='; fixture and terminal evidence retained at '+dir;throw error;
 }finally{
  await client.close();if(owner&&await ownerAlive(owner.owner))process.kill(owner.owner.pid,'SIGTERM');if(owner)await waitOwnerExit(owner.owner);tui.stdin.destroy();if(tui.exitCode===null)tui.kill('SIGTERM');if(!failure)await fs.rm(dir,{recursive:true,force:true,maxRetries:3,retryDelay:100});
 }
});
