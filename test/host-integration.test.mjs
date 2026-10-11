import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, RpcClient, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { processIdentity, readClaim } from '../src/attachments.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { createRpcHostBinding, createSdkHostBinding } from '../src/host-bindings.mjs';

const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function until(fn){const end=Date.now()+12000;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,20));}throw new Error('HOST_FIXTURE_TIMEOUT');}
async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-host-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'host-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,delete:true,new_session:true}],attachmentDir:path.join(dir,'ipc')};
 let spawned=0;
 const bridge=await new Bridge(config,async()=>{spawned++;throw new Error('UNEXPECTED_BRIDGE_SPAWN');}).init();
 const controllers=[],cleanups=[];
 t.after(async()=>{for(const cleanup of cleanups)await cleanup();for(const controller of controllers)await controller.close();await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const create=async key=>{const made=await bridge.create({folder_id:'project',request_id:key});return bridge.session(made.session_id);};
 return {dir,cwd,config,bridge,create,controllers,cleanups,spawned:()=>spawned};
}

test('official host-owned Pi RPC serves bridge reads and sends without spawning; timed-out replies do not redispatch',async t=>{
 const f=await fixture(t),saved=await f.create('rpc-seed'),pidFile=path.join(f.dir,'writer-pid.json');
 const extension=path.join(f.dir,'pid-extension.mjs');
 await fs.writeFile(extension,`import fs from 'node:fs';export default function(){fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify(process.pid));}`);
 const client=new RpcClient({cliPath:path.join(base,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),cwd:f.cwd,env:{HOME:f.dir,PI_CODING_AGENT_DIR:path.join(f.dir,'agent'),PI_OFFLINE:'1'},provider:'bridge-fixture',model:'deterministic',args:['--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-tools','-e',path.join(base,'research/faux-extension.mjs'),'-e',extension]});
 f.cleanups.push(()=>client.stop());await client.start();await client.getState();
 const pid=JSON.parse(await fs.readFile(pidFile,'utf8')),owner=await processIdentity(pid);assert.notEqual(pid,process.pid);
 const controller=await reserveHostSession({attachmentDir:f.config.attachmentDir,session:saved,owner});f.controllers.push(controller);
 await client.switchSession(saved.file);
 const binding=createRpcHostBinding(client),gate=deferred();let submissions=0;
 f.cleanups.unshift(()=>gate.resolve());
 await controller.ready({...binding,submit:async args=>{submissions++;const result=await binding.submit(args);if(args.text==='PUBLIC_DELAYED_REPLY')await gate.promise;return result;}});
 const first=await f.bridge.send({session_id:saved.id,request_id:'rpc-first',text:'PUBLIC_RPC_INPUT'});
 assert.equal(first.status,'accepted');assert.equal(submissions,1);
 await until(async()=>!(await client.getState()).isStreaming);
 const raw=await f.bridge.read({session_id:saved.id,view:'raw'});assert.match(JSON.stringify(raw),/PUBLIC_RPC_INPUT/);
 assert.equal((await readClaim(f.config.attachmentDir,saved)).owner.pid,pid);assert.equal(f.spawned(),0);
 const delayedArgs={session_id:saved.id,request_id:'rpc-lost-reply',text:'PUBLIC_DELAYED_REPLY',timeout_ms:30};
 const delayed=await f.bridge.send(delayedArgs);assert.equal(delayed.status,'unknown');assert.equal(submissions,2);
 assert.deepEqual(await f.bridge.send(delayedArgs),delayed);assert.equal(submissions,2);
 gate.resolve();await until(async()=>!(await client.getState()).isStreaming);
 const entries=await client.getEntries();assert.equal(entries.entries.filter(e=>e.message?.role==='user'&&JSON.stringify(e.message.content).includes('PUBLIC_DELAYED_REPLY')).length,1);
 const denied=await f.bridge.delete({session_id:saved.id,request_id:'unsupported-release'});
 assert.equal(denied.status,'rejected');assert.ok(await fs.stat(saved.file));
 assert.equal((await client.getState()).sessionId,saved.header.id);assert.equal(f.spawned(),0);
 // Losing the controller endpoint cannot turn a surviving child into a cold
 // session. Keep its exact owner claim and refuse bridge-managed fallback.
 await controller.close();
 assert.ok(await processIdentity(pid));
 await assert.rejects(f.bridge.read({session_id:saved.id,view:'raw'}));
 const unreachable=await f.bridge.send({session_id:saved.id,request_id:'closed-controller',text:'MUST_NOT_DISPATCH'});
 assert.equal(unreachable.status,'rejected');assert.equal(f.spawned(),0);assert.equal(submissions,2);
 assert.equal((await readClaim(f.config.attachmentDir,saved)).owner.pid,pid);
 assert.equal((await client.getState()).sessionId,saved.header.id);
});

test('two official SDK sessions in one host PID release independently without shutting down their neighbor',async t=>{
 const f=await fixture(t),savedA=await f.create('sdk-a'),savedB=await f.create('sdk-b');
 const faux=fauxProvider({provider:'host-sdk-fixture'});faux.setResponses([fauxAssistantMessage('PUBLIC_A_REPLY'),fauxAssistantMessage('PUBLIC_B_REPLY')]);
 const modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});modelRuntime.registerNativeProvider(faux.provider);
 const hosts=[];
 for(const saved of [savedA,savedB]){
  const controller=await reserveHostSession({attachmentDir:f.config.attachmentDir,session:saved});f.controllers.push(controller);
  const agentDir=path.join(f.dir,saved===savedA?'agent-a':'agent-b'),settings=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}});
  const loader=new DefaultResourceLoader({cwd:f.cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,systemPrompt:'Public offline host fixture.'});await loader.reload();
  const {session}=await createAgentSession({cwd:f.cwd,agentDir,modelRuntime,model:faux.getModel(),thinkingLevel:'off',tools:[],resourceLoader:loader,sessionManager:SessionManager.open(saved.file),settingsManager:settings});
  let released=0;f.cleanups.push(async()=>{await session.abort();session.dispose();});
  await controller.ready(createSdkHostBinding(session,{release:async()=>{await session.abort();session.dispose();released++;return {released:true};}}));
  hosts.push({session,get released(){return released;}});
 }
 const claimA=await readClaim(f.config.attachmentDir,savedA),claimB=await readClaim(f.config.attachmentDir,savedB);
 assert.equal(claimA.owner.pid,process.pid);assert.equal(claimB.owner.pid,process.pid);
 assert.notEqual(claimA.generation,claimB.generation);
 const sentA=await f.bridge.send({session_id:savedA.id,request_id:'sdk-send-a',text:'PUBLIC_A_INPUT'});assert.equal(sentA.status,'unknown');
 await until(()=>!hosts[0].session.isStreaming&&faux.state.callCount===1);
 assert.match(JSON.stringify(await f.bridge.read({session_id:savedA.id,view:'raw'})),/PUBLIC_A_INPUT/);
 const removed=await f.bridge.delete({session_id:savedA.id,request_id:'sdk-delete-a'});assert.equal(removed.status,'deleted');
 assert.equal(hosts[0].released,1);assert.equal(hosts[1].released,0);
 assert.equal((await readClaim(f.config.attachmentDir,savedB)).generation,claimB.generation);
 const sentB=await f.bridge.send({session_id:savedB.id,request_id:'sdk-send-b',text:'PUBLIC_B_INPUT'});assert.equal(sentB.status,'unknown');
 await until(()=>!hosts[1].session.isStreaming&&faux.state.callCount===2);
 assert.match(JSON.stringify(await f.bridge.read({session_id:savedB.id,view:'raw'})),/PUBLIC_B_INPUT/);
 assert.ok(await fs.stat(savedB.file));assert.equal(f.spawned(),0);
});

test('SDK async input preparation must finish before host release permits a saved file move',async t=>{
 const f=await fixture(t),saved=await f.create('sdk-preparation');
 const controller=await reserveHostSession({attachmentDir:f.config.attachmentDir,session:saved});f.controllers.push(controller);
 const entered=deferred(),gate=deferred(),releasing=deferred();let releaseFinished=false;
 const settings=SettingsManager.inMemory({cacheWarming:'off',retry:{enabled:false},compaction:{enabled:false}}),agentDir=path.join(f.dir,'agent-preparation');
 const loader=new DefaultResourceLoader({cwd:f.cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,systemPrompt:'Public preparation fixture.',extensionFactories:[pi=>{
  pi.on('input',async()=>{entered.resolve();await gate.promise;return {action:'handled'};});
 }]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const faux=fauxProvider({provider:'host-preparation-fixture'}),modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});modelRuntime.registerNativeProvider(faux.provider);
 const {session}=await createAgentSession({cwd:f.cwd,agentDir,modelRuntime,model:faux.getModel(),thinkingLevel:'off',tools:[],resourceLoader:loader,sessionManager:SessionManager.open(saved.file),settingsManager:settings});
 const extensionErrors=[];await session.bindExtensions({mode:'rpc',onError:error=>extensionErrors.push(error)});
 // The host owns all admission paths, including its own UI/router. Track the
 // public prompt promise: streaming flags alone cannot account for preparation.
 const pending=new Set();let accepting=true;
 const hostSession={get sessionFile(){return session.sessionFile;},get sessionId(){return session.sessionId;},get sessionManager(){return session.sessionManager;},get isIdle(){return session.isIdle;},get isStreaming(){return session.isStreaming;},get isCompacting(){return session.isCompacting;},get pendingMessageCount(){return session.pendingMessageCount;},prompt:(text,options)=>{
  if(!accepting)throw new Error('HOST_CLOSED');
  const work=session.prompt(text,options);pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;
 }};
 f.cleanups.unshift(async()=>{gate.resolve();await Promise.allSettled([...pending]);await session.abort();session.dispose();});
 await controller.ready(createSdkHostBinding(hostSession,{release:async()=>{
  accepting=false;releasing.resolve();await Promise.allSettled([...pending]);await session.abort();session.dispose();releaseFinished=true;return {released:true};
 }}));
 const sent=await f.bridge.send({session_id:saved.id,request_id:'preparation-send',text:'PUBLIC_ASYNC_PREPARATION'});
 assert.equal(sent.status,'unknown');await entered.promise;assert.equal(pending.size,1);
 let deletionFinished=false;
 const deletion=f.bridge.delete({session_id:saved.id,request_id:'preparation-delete'}).then(value=>{deletionFinished=true;return value;});
 await releasing.promise;
 assert.equal(accepting,false);assert.equal(releaseFinished,false);assert.equal(deletionFinished,false);
 assert.ok(await fs.stat(saved.file));assert.ok(await readClaim(f.config.attachmentDir,saved));
 // Let queued I/O complete while the actual extension remains blocked.
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(deletionFinished,false);assert.ok(await fs.stat(saved.file));
 gate.resolve();assert.equal((await deletion).status,'deleted');assert.equal(releaseFinished,true);
 await assert.rejects(fs.stat(saved.file),{code:'ENOENT'});
 assert.equal(faux.state.callCount,0);assert.deepEqual(extensionErrors,[]);assert.equal(f.spawned(),0);
});
