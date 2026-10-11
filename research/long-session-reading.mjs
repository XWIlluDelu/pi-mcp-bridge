// Reproducible usability exercise, not a real-model quality benchmark.
// Only public SDK APIs, native session persistence and offline faux responses.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {fauxProvider,fauxAssistantMessage,fauxToolCall,InMemoryCredentialStore} from '@earendil-works/pi-ai';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {Bridge} from '../src/bridge.mjs';
const base=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dir=process.argv[2]?path.resolve(process.argv[2]):await fs.mkdtemp(path.join(os.tmpdir(),'pi-long-read-'));
await fs.mkdir(dir,{recursive:true});
const cwd=path.join(dir,'project'),agentDir=path.join(dir,'agent');await fs.mkdir(cwd);await fs.mkdir(agentDir);
const config={principal:'public-long-read-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,send:true,new_session:true}]};
const bridge=await new Bridge(config).init();const made=await bridge.create({folder_id:'project',request_id:'fixture-create'}),saved=await bridge.session(made.session_id);await bridge.close();
const manager=SessionManager.open(saved.file),settings=SettingsManager.inMemory({cacheWarming:'off',compaction:{enabled:false,keepRecentTokens:1},retry:{enabled:false}});
const faux=fauxProvider({provider:'long-read-fixture'}),modelRuntime=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,refreshOnCreate:false,allowModelNetwork:false});modelRuntime.registerNativeProvider(faux.provider);
let keep,extension,compactions=0,trees=0;
const resources=new DefaultResourceLoader({cwd,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,systemPrompt:'Public offline session-reading fixture.',extensionFactories:[pi=>{
 extension=pi;
 pi.on('session_before_compact',event=>{compactions++;return {compaction:{summary:'Checkpoint: build a local CSV import parser. Earlier plan accepted empty identifiers; replace that behavior. Keep diagnosis, repair and verification below. No deployment authorized.',firstKeptEntryId:keep,tokensBefore:event.preparation.tokensBefore}};});
 pi.on('session_before_tree',()=>{trees++;return {summary:{summary:'Discarded branch proposed a database migration. Return to the local parser; the migration proposal is not the current plan.'}};});
}]});await resources.reload();
const {session}=await createAgentSession({cwd,agentDir,modelRuntime,model:faux.getModel(),thinkingLevel:'off',tools:['write','bash','read'],resourceLoader:resources,sessionManager:manager,settingsManager:settings});
const errors=[];await session.bindExtensions({mode:'rpc',onError:error=>errors.push(error)});
const trace=[];session.subscribe(e=>{if(['tool_execution_start','tool_execution_end','agent_settled'].includes(e.type))trace.push({type:e.type,toolName:e.toolName,isError:e.isError});});
let client;
const answer=text=>fauxAssistantMessage(text);
const tool=(name,args,id)=>fauxAssistantMessage(fauxToolCall(name,args,{id}),{stopReason:'toolUse'});
const snapshots={};
try{
 for(let i=0;i<12;i++){
  faux.setResponses([answer(`Design note ${i+1}: local CSV parser discussion. `+'Discuss delimiter handling, whitespace, and stable row order. '.repeat(95))]);
  await session.prompt(`Design iteration ${i+1}. Keep this as background, no external services.`);
 }
 const check="node -e \"const p=require('./parser.cjs'); if(p('')!==null) throw new Error('EMPTY_IDENTIFIER_ACCEPTED'); console.log('EMPTY_IDENTIFIER_REJECTED');\"";
 faux.setResponses([
  tool('write',{path:'parser.cjs',content:"module.exports = value => value.trim();\n"},'write-bug'),
  tool('bash',{command:check},'check-fail'),
  tool('write',{path:'parser.cjs',content:"module.exports = value => value.trim() || null;\n"},'write-repair'),
  tool('bash',{command:check},'check-pass'),
  tool('bash',{command:"node -e \"for(let i=0;i<350;i++) console.log('row '+i+': public regression trace, whitespace and empty identifier fixtures passed');\""},'long-log'),
  answer('Parser implementation updated. '+'Public verification note. '.repeat(70)+' Key change: empty identifiers now return null. Failure EMPTY_IDENTIFIER_ACCEPTED was repaired and EMPTY_IDENTIFIER_REJECTED passed. Pending: Unicode identifier cases have not been tested.')
 ]);
 await session.prompt('Implement the CSV identifier parser and verify empty identifiers. Leave Unicode validation for a later step.');
 const entries=manager.getEntries();keep=entries.find(e=>e.message?.role==='assistant'&&e.message.content?.some(c=>c.type==='toolCall'&&c.id==='write-bug')).id;
 const repairedLeaf=manager.getLeafId();
 snapshots.pre_compaction={entries:manager.getEntries(),leaf:repairedLeaf};
 await session.compact();
 const checkpointLeaf=manager.getLeafId();
 faux.setResponses([answer('ABANDONED_MIGRATION_PROPOSAL: replace the local parser with a database service.')]);
 await session.prompt('Explore an alternative database migration on a separate branch.');
 const abandonedLeaf=manager.getLeafId();
 await session.navigateTree(checkpointLeaf,{summarize:true,label:'local-parser-return'});
 faux.setResponses([answer('Current scope: local CSV parser only. Empty identifiers are repaired. Pending: add Unicode cases and a concise README; do not deploy.')]);
 await session.prompt('CURRENT_GOAL: keep the local CSV parser, reject empty identifiers, add Unicode coverage next. Do not pursue the database migration.');
 extension.appendEntry('public-fixture-state',{marker:'RAW_ONLY_FIXTURE_STATE'});
 extension.sendMessage({customType:'pending-note',display:false,content:'PENDING_EXTENSION_NOTE: Unicode normalization policy still needs a decision; README remains unwritten.'},{triggerTurn:false});
 // Display-hidden is still projected. Explicit context edits are a different boundary.
 extension.sendMessage({customType:'obsolete-note',display:false,content:'CONTEXT_HIDDEN_OBSOLETE_NOTE'},{triggerTurn:false});
 const hidden=manager.getEntries().findLast(e=>e.type==='custom_message'&&e.customType==='obsolete-note');manager.appendContextEdit(hidden.id,null);
 snapshots.post_compaction={entries:manager.getEntries(),leaf:manager.getLeafId(),abandonedLeaf};
 assert.equal(compactions,1);assert.equal(trees,1);assert.deepEqual(errors,[]);
 assert.equal(await fs.readFile(path.join(cwd,'parser.cjs'),'utf8'),"module.exports = value => value.trim() || null;\n");
 session.dispose();
 const filename=path.join(dir,'owner-config.json');await fs.writeFile(filename,JSON.stringify(config));
 client=new Client({name:'long-session-reader',version:'1.0.0'});
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(base,'src/server.mjs'),filename],cwd:base,env:{PATH:process.env.PATH,HOME:dir,PI_OFFLINE:'1'},stderr:'pipe'}));
 const requests=[];
 async function read(args){const result=await client.callTool({name:'read',arguments:{session_id:made.session_id,...args}});assert.ok(!result.isError,JSON.stringify(result));requests.push({args,response:result.structuredContent});return result.structuredContent;}
 async function collect(args){let cursor,partial='',items=[],pages=0;do{const page=await read({...args,cursor});pages++;for(const r of page.items){if(r.json_fragment!==undefined){assert.equal(r.char_offset,partial.length);partial+=r.json_fragment;if(partial.length===r.total_chars){items.push(JSON.parse(partial));partial='';}}else{assert.equal(partial,'');items.push(r);}}cursor=page.next_cursor;}while(cursor);return {items,pages};}
 const bytesBefore=await fs.readFile(saved.file,'utf8'),callsBefore=faux.state.callCount;
 const contextFirst=await read({view:'context'}),overviewFirst=await read({view:'overview'});
 const context=await collect({view:'context'}),overview=await collect({view:'overview'}),summaries=await collect({view:'summary'});
 const expanded=[],focused=[];
 for(const id of ['check-fail','check-pass']){
  const observation=overview.items.find(r=>r.kind==='tool_observation'&&r.payload.value?.call_id===id);assert.ok(observation);
  const result=await collect({view:'context',entry_id:observation.result_source.entry_id});
  assert.ok(result.items.some(r=>r.message?.isError===(id==='check-fail')));
  assert.ok(JSON.stringify(result.items).includes(id==='check-fail'?'Error: EMPTY_IDENTIFIER_ACCEPTED':'EMPTY_IDENTIFIER_REJECTED\\n'));
  focused.push({call:id,source:observation.result_source,...result});
 }
 assert.ok(JSON.stringify(overview.items).includes('value.trim() || null'));
 assert.ok(JSON.stringify(overview.items).includes('Unicode normalization policy'));
 const expandedIds=new Set();
 for(const r of overview.items){
  if(r.payload?.json_excerpt&&!expandedIds.has(r.entry_id)){expandedIds.add(r.entry_id);expanded.push({why:r.label,source:{entry_id:r.entry_id,message_index:r.message_index},...await collect({view:'context',entry_id:r.entry_id})});}
 }
 const abandoned=await collect({view:'context',leaf_id:abandonedLeaf});
 const hiddenRaw=await collect({view:'raw',entry_id:hidden.id});
 assert.ok(JSON.stringify(context.items).includes('CURRENT_GOAL'));
 assert.ok(JSON.stringify(overview.items).includes('CURRENT_GOAL'));
 assert.ok(JSON.stringify(context.items).includes('PENDING_EXTENSION_NOTE'));
 assert.ok(!JSON.stringify(context.items).includes('CONTEXT_HIDDEN_OBSOLETE_NOTE'));
 assert.ok(!JSON.stringify(overview.items).includes('CONTEXT_HIDDEN_OBSOLETE_NOTE'));
 assert.ok(!JSON.stringify(overview.items).includes('RAW_ONLY_FIXTURE_STATE'));
 assert.ok(!JSON.stringify(context.items).includes('ABANDONED_MIGRATION_PROPOSAL'));
 assert.ok(JSON.stringify(abandoned.items).includes('ABANDONED_MIGRATION_PROPOSAL'));
 assert.ok(JSON.stringify(hiddenRaw.items).includes('CONTEXT_HIDDEN_OBSOLETE_NOTE'));
 assert.equal(await fs.readFile(saved.file,'utf8'),bytesBefore);assert.equal(faux.state.callCount,callsBefore);
 const report={session_id:made.session_id,session_file:path.relative(dir,saved.file),sdk_provider:'offline faux; no real model',provider_calls:faux.state.callCount,compactions,tree_navigations:trees,tool_executions:trace.filter(e=>e.type==='tool_execution_end'),
  original_entries:snapshots.pre_compaction.entries.length,final_entries:manager.getEntries().length,
  context_first_contains_goal:JSON.stringify(contextFirst.items).includes('CURRENT_GOAL'),overview_first_contains_goal:JSON.stringify(overviewFirst.items).includes('CURRENT_GOAL'),
  context_pages:context.pages,overview_pages:overview.pages,
  overview_tool_statuses:overview.items.filter(r=>r.kind==='tool_observation').map(r=>({call:r.payload.value?.call_id,status:r.status,result:r.result_source?.entry_id})),
  overview_manifest:overview.items[0],summaries:summaries.items,
  focused_result_reads:focused.map(x=>({call:x.call,entry_id:x.source.entry_id,pages:x.pages})),
  branch_summary_selected:overview.items.some(r=>r.kind==='branch_summary'),
  expansion_requests:expanded.map(x=>({why:x.why,entry_id:x.source.entry_id,pages:x.pages})),
  current_goal:'Local CSV identifier parser; reject empty identifiers; Unicode coverage next; no database migration or deployment.',
  critical_change:'Empty identifier now returns null, rather than empty string.',
  failure_and_repair:'Actual bash check failed EMPTY_IDENTIFIER_ACCEPTED; write repaired parser; actual bash check passed EMPTY_IDENTIFIER_REJECTED.',
  unfinished:'Unicode normalization policy and tests; README.',
  readonly_checks:{session_unchanged:true,no_extra_provider_calls:true,hidden_content_excluded:true,abandoned_branch_requires_explicit_leaf:true}};
 await fs.writeFile(path.join(dir,'evidence.json'),JSON.stringify({report,requests,focused,expanded,snapshots,trace},null,2));
 await fs.writeFile(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{session.dispose();await client?.close();}
