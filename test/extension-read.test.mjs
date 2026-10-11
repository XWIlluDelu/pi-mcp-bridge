import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { Bridge } from '../src/bridge.mjs';
import { PiRpc } from '../src/rpc.mjs';

async function fixture(t){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-ext-read-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'extension-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,new_session:true}]};
 const bridge=await new Bridge(config).init();const made=await bridge.create({folder_id:'project',request_id:'seed'}),saved=await bridge.session(made.session_id);
 t.after(async()=>{await bridge.close();await fs.rm(dir,{recursive:true,force:true});});return {dir,cwd,config,bridge,saved,id:made.session_id};
}
async function sdk(t,f,factory,expectedCalls=0){
 const manager=SessionManager.open(f.saved.file),old=manager.appendMessage({role:'user',content:'PUBLIC_OLD',timestamp:1});
 manager.appendMessage(fauxAssistantMessage('PUBLIC_PRIOR_REPLY'));
 const kept=manager.appendMessage({role:'user',content:'PUBLIC_KEPT',timestamp:2});
 const settings=SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false,keepRecentTokens:1},retry:{enabled:false}});
 const loader=new DefaultResourceLoader({cwd:f.cwd,agentDir:path.join(f.dir,'agent'),settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Public offline fixture.',extensionFactories:[pi=>factory(pi,{old,kept})]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const faux=fauxProvider({provider:'read-fixture'}),modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});modelRuntime.registerNativeProvider(faux.provider);
 const {session}=await createAgentSession({cwd:f.cwd,agentDir:path.join(f.dir,'agent'),modelRuntime,model:faux.getModel(),thinkingLevel:'off',tools:[],resourceLoader:loader,sessionManager:manager,settingsManager:settings});
 const errors=[];await session.bindExtensions({mode:'rpc',onError:e=>errors.push(e)});
 t.after(()=>{session.dispose();assert.deepEqual(errors,[]);assert.equal(faux.state.callCount,expectedCalls,'Only explicitly scripted offline provider calls may occur');});return {session,manager,old,kept,faux};
}

test('original custom compaction hook preserves native summary, retained boundary and raw provenance',async t=>{
 const f=await fixture(t);let compactCalls=0;
 const {session,manager,kept,old}=await sdk(t,f,(pi,ids)=>pi.on('session_before_compact',event=>{compactCalls++;return {compaction:{summary:'PUBLIC_EXTENSION_CHECKPOINT',firstKeptEntryId:ids.kept,tokensBefore:event.preparation.tokensBefore,details:{fixture:true}}};}));
 await session.compact();assert.equal(compactCalls,1);
 const entry=manager.getEntries().find(e=>e.type==='compaction');assert.equal(entry.fromHook,true);
 const summary=await f.bridge.read({session_id:f.id,view:'summary'});assert.deepEqual(summary.items,[{entry_id:entry.id,type:'compaction',summary:'PUBLIC_EXTENSION_CHECKPOINT'}]);
 const context=await f.bridge.read({session_id:f.id});assert.ok(JSON.stringify(context).includes('PUBLIC_KEPT'));assert.ok(!JSON.stringify(context).includes('PUBLIC_OLD'));assert.equal(context.context_kind,'pi_session_projection_not_final_provider_payload');
 const raw=await f.bridge.read({session_id:f.id,view:'raw',entry_id:entry.id});assert.equal(raw.items[0].entry.firstKeptEntryId,kept);assert.equal(raw.items[0].entry.fromHook,true);
 assert.ok((await f.bridge.read({session_id:f.id,view:'raw',entry_id:old})).items.length);assert.equal(compactCalls,1,'Reads do not rerun compaction hooks');
});
test('display-hidden custom messages remain projected while custom extension state is raw-only',async t=>{
 const f=await fixture(t);
 await sdk(t,f,pi=>pi.on('session_start',async(_event,ctx)=>{pi.appendEntry('fixture-state',{marker:'PUBLIC_CUSTOM_STATE'});pi.sendMessage({customType:'fixture-hidden',content:'PUBLIC_HIDDEN_MESSAGE',display:false},{triggerTurn:false});}));
 const context=await f.bridge.read({session_id:f.id}),raw=await f.bridge.read({session_id:f.id,view:'raw'});
 assert.ok(context.items.some(x=>x.message?.role==='custom'&&x.message.display===false&&x.message.content==='PUBLIC_HIDDEN_MESSAGE'));
 assert.ok(!JSON.stringify(context).includes('PUBLIC_CUSTOM_STATE'));assert.ok(JSON.stringify(raw).includes('PUBLIC_CUSTOM_STATE'));assert.ok(raw.items.some(x=>x.entry.type==='custom_message'&&x.entry.display===false));
 f.config.grants.push({session_id:f.id,read:false});for(const view of ['context','raw','summary'])await assert.rejects(f.bridge.read({session_id:f.id,view}),/NOT_FOUND_OR_DENIED/);
});
test('request-time filtering differs from saved projection; reads neither replay hooks nor call a provider',async t=>{
 const f=await fixture(t);let contextCalls=0,beforeCalls=0;
 const {session,faux}=await sdk(t,f,pi=>{
  pi.on('session_start',async(_event,ctx)=>{pi.sendMessage({customType:'fixture-plan',content:'PUBLIC_OLD_PLAN',display:false},{triggerTurn:false});});
  pi.on('context',event=>{contextCalls++;return {messages:event.messages.filter(m=>m.customType!=='fixture-plan')};});
  pi.on('before_agent_start',()=>{beforeCalls++;return {systemPrompt:'PUBLIC_FORCED_MEMORY'};});
 },1);
 const fileBefore=await fs.readFile(f.saved.file,'utf8'),readBefore=await f.bridge.read({session_id:f.id});
 assert.ok(JSON.stringify(readBefore).includes('PUBLIC_OLD_PLAN'));assert.equal(contextCalls,0);assert.equal(beforeCalls,0);
 // Capture through the public faux-provider response factory. Never replace
 // Pi methods: the real SDK runs its normal preparation and persistence.
 let requestMessages;
 faux.setResponses([context=>{requestMessages=context.messages;return fauxAssistantMessage('PUBLIC_OFFLINE_REPLY');}]);
 await session.prompt('PUBLIC_FIXTURE_PROMPT');
 assert.equal(contextCalls,1);assert.equal(beforeCalls,1);assert.ok(!JSON.stringify(requestMessages).includes('PUBLIC_OLD_PLAN'));assert.equal(requestMessages[0].role,'system');assert.equal(requestMessages[0].content,'PUBLIC_FORCED_MEMORY');
 const afterPrompt=await fs.readFile(f.saved.file,'utf8');assert.notEqual(afterPrompt,fileBefore);
 const readAfter=await f.bridge.read({session_id:f.id});assert.ok(JSON.stringify(readAfter).includes('PUBLIC_OLD_PLAN'));assert.equal(readAfter.context_kind,'pi_session_projection_not_final_provider_payload');assert.ok(!JSON.stringify(readAfter).includes('PUBLIC_FORCED_MEMORY'));assert.equal(await fs.readFile(f.saved.file,'utf8'),afterPrompt);
 assert.equal(contextCalls,1);assert.equal(beforeCalls,1);
});
test('configured agentDir does not discover extensions but explicit -e loads an owner-selected extension',async t=>{
 const f=await fixture(t),agentDir=path.join(f.dir,'owner-agent'),extensions=path.join(agentDir,'extensions');await fs.mkdir(extensions,{recursive:true});
 await fs.writeFile(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',compaction:{enabled:false},retry:{enabled:false}}));
 const extension=path.join(extensions,'original-fixture.mjs');await fs.writeFile(extension,"export default function(pi){pi.on('session_start',()=>pi.appendEntry('profile-marker',{loaded:true}));}");
 f.config.piRuntime={agentDir};let rpc;
 try{
  rpc=await new PiRpc(f.config,f.saved).start();assert.ok(!(await rpc.entries()).entries.some(x=>x.customType==='profile-marker'));await rpc.stop();
  f.config.piArgs=['-e',extension];rpc=await new PiRpc(f.config,f.saved).start();assert.ok((await rpc.entries()).entries.some(x=>x.customType==='profile-marker'));
 }finally{await rpc?.stop();}
});
