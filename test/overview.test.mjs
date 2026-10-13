import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SessionManager} from '@earendil-works/pi-coding-agent';
import {Bridge} from '../src/bridge.mjs';
import { renderRead, recordsFor } from '../src/data.mjs';
import { hash } from '../src/storage.mjs';
import {readClaim,AttachedRuntime} from '../src/attachments.mjs';
import attachExtension from '../src/attach-extension.mjs';
import {isolatedRuntime} from './fixtures/isolated-runtime.mjs';
import {overviewRecords} from '../src/overview.mjs';
import {operationSchemas,batchSchema} from '../src/tool-schemas.mjs';
const message=(id,parentId,role,content,extra={})=>({type:'message',id,parentId,message:{role,content,...extra}});
const data=entries=>({entries,leafId:entries.at(-1)?.id??null,revision:hash(entries)});
const overview=entries=>recordsFor(data(entries),{view:'overview'});
const payloadText=r=>JSON.stringify(r.payload);

test('native context edit samples replacement text blocks without resurrecting original markers',()=>{
 const content=[{type:'thinking',thinking:'OMIT_REPLACEMENT_THINKING'},
  {type:'text',text:'PUBLIC_REPLACEMENT_FIRST'},
  {type:'text',text:'PUBLIC_REPLACEMENT_MIDDLE '+ 'x'.repeat(4000)+' PUBLIC_REPLACEMENT_TAIL'},
  {type:'text',text:'PUBLIC_REPLACEMENT_LAST'}];
 const entries=[message('u',null,'user','public request'),message('a','u','assistant',[
  {type:'text',text:'HIDDEN_ORIGINAL_FIRST'},{type:'text',text:'HIDDEN_ORIGINAL_LAST'}]),
  {type:'context_edit',id:'edit',parentId:'a',targetId:'a',replacement:{content}}];
 const rows=overview(entries),row=rows.find(r=>r.label==='latest_assistant'),serialized=JSON.stringify(rows);
 assert.equal(row.entry_id,'a');
 const blocks=[row,...row.additional_text_blocks];
 assert.deepEqual(blocks.map(block=>block.payload_source.block_index),[1,3,2]);
 for(const marker of ['PUBLIC_REPLACEMENT_FIRST','PUBLIC_REPLACEMENT_MIDDLE','PUBLIC_REPLACEMENT_TAIL','PUBLIC_REPLACEMENT_LAST'])assert.ok(serialized.includes(marker),marker);
 assert.ok(!serialized.includes('HIDDEN_ORIGINAL'));assert.ok(!serialized.includes('OMIT_REPLACEMENT_THINKING'));
 assert.deepEqual(row.omitted_content_block_ranges,[[0,1]]);
 const middle=blocks[2].payload,json=JSON.stringify(content[2].text);
 assert.equal(middle.json_excerpt,json.slice(0,middle.omitted_char_ranges[0][0]));
 assert.equal(middle.json_tail_excerpt,json.slice(middle.tail_char_offset));
 assert.equal(middle.json_excerpt.length+middle.json_tail_excerpt.length,
  1000-JSON.stringify(content[1].text).length-JSON.stringify(content[3].text).length);
 assert.ok(JSON.stringify(recordsFor(data(entries),{view:'raw',entry_id:'a'})).includes('HIDDEN_ORIGINAL_FIRST'));
 assert.ok(JSON.stringify(recordsFor(data(entries),{view:'overview',leaf_id:'a'})).includes('HIDDEN_ORIGINAL_FIRST'));
});

test('tool-use overview omits synthetic opaque thinking metadata and preserves raw expansion',()=>{
 const signature=JSON.stringify({encrypted_content:'SYNTHETIC_OPAQUE_'.repeat(800)});
 const entries=[message('u',null,'user','public request'),message('call','u','assistant',[
  {type:'thinking',thinking:'SYNTHETIC_THINKING',thinkingSignature:signature},
  {type:'toolCall',id:'tool-1',name:'read',arguments:{path:'public-fixture.txt',thinkingSignature:'ARGUMENT_VALUE'},thoughtSignature:signature},
  {type:'toolCall',id:'tool-2',name:'ls',arguments:{path:'.'}}
 ],{stopReason:'toolUse'}),message('final','call','assistant',[{type:'text',text:'FINAL'}])];
 const before=JSON.stringify(entries),rows=overview(entries),row=rows.find(r=>r.kind==='message'&&r.entry_id==='call');
 assert.ok(payloadText(row).includes('public-fixture.txt'));
 assert.ok(payloadText(row).includes('ARGUMENT_VALUE'),'semantic arguments are not recursively filtered');
 assert.equal(JSON.stringify(rows).includes('SYNTHETIC_'),false);
 assert.equal(row.stopReason,'toolUse');assert.equal(row.payload_source.block_index,1);
 assert.deepEqual(row.payload_source.fields,['type','id','name','arguments']);
 assert.deepEqual(row.omitted_content_block_ranges,[[0,1],[2,3]]);assert.equal(row.omitted_content_block_count,2);
 assert.equal(rows.filter(r=>r.kind==='tool_observation').length,2);
 const raw=recordsFor(data(entries),{view:'raw',entry_id:'call'});
 assert.equal(raw[0].entry.message.content[0].thinkingSignature,signature);
 assert.ok(JSON.stringify(recordsFor(data(entries),{view:'context'})).includes('SYNTHETIC_OPAQUE_'));
 assert.equal(JSON.stringify(entries),before);
});

test('thinking-only overview keeps bounded status and omission references without opaque payloads',()=>{
 const rows=overview([message('u',null,'user','request'),message('a','u','assistant',Array.from({length:2500},()=>({type:'thinking',thinking:'SYNTHETIC_THINKING',thinkingSignature:'SYNTHETIC_OPAQUE'})),{stopReason:'error',errorMessage:'public error'})]);
 const row=rows.find(r=>r.label==='latest_assistant');assert.ok(row);
 assert.equal(row.stopReason,'error');assert.equal(row.errorMessage,'public error');
 assert.deepEqual(row.omitted_content_block_ranges,[[0,2500]]);assert.equal(row.omitted_content_block_count,2500);
 assert.equal(JSON.stringify(rows).includes('SYNTHETIC_'),false);assert.ok(JSON.stringify(row).length<1000);
});

test('overview prioritizes projected assistant text and exposes bounded outcome fields',()=>{
 const entries=[message('u',null,'user','public request'),message('a','u','assistant',[
  {type:'thinking',thinking:'x'.repeat(3900)},{type:'text',text:'VISIBLE_FINAL'}
 ],{stopReason:'error',errorMessage:'PUBLIC_ERROR '+ 'e'.repeat(1000)})];
 const row=overview(entries).find(r=>r.label==='latest_assistant');
 assert.equal(row.payload.value,'VISIBLE_FINAL');assert.equal(row.stopReason,'error');assert.equal(row.errorMessage.length,256);
 assert.deepEqual(row.payload_source,{field:'content',block_index:1,block_field:'text'});
 assert.deepEqual(row.omitted_content_block_ranges,[[0,1]]);assert.equal(row.omitted_content_block_count,1);assert.equal(row.field_omissions[0].field,'errorMessage');
});

test('overview retains latest assistant text when thousands of other blocks are omitted',()=>{
 const content=[...Array.from({length:2500},()=>({type:'thinking',thinking:'x'})),{type:'text',text:'FINAL'},{type:'thinking',thinking:'after'}];
 const rows=overview([message('u',null,'user','public request'),message('a','u','assistant',content)]);
 const row=rows.find(r=>r.label==='latest_assistant');
 assert.ok(row,'latest assistant must fit the overview budget');
 assert.equal(row.payload.value,'FINAL');assert.equal(row.payload_source.block_index,2500);
 assert.deepEqual(row.omitted_content_block_ranges,[[0,2500],[2501,2502]]);
 assert.equal(row.omitted_content_block_count,2501);
 assert.ok(JSON.stringify(row).length<1000);
});

test('overview reports a projected failed result without recovering its hidden call',()=>{
 const entries=[message('u',null,'user','public request'),message('call','u','assistant',[
  {type:'toolCall',id:'t',name:'bash',arguments:{command:'HIDDEN_COMMAND'}}
 ]),message('result','call','toolResult','x'.repeat(10000),{toolCallId:'t',isError:true}),
 {type:'context_edit',id:'hide',parentId:'result',targetId:'call',replacement:null}];
 const rows=overview(entries),result=rows.find(r=>r.kind==='message'&&r.entry_id==='result'),tool=rows.find(r=>r.kind==='tool_observation');
 assert.equal(result.isError,true);assert.equal(result.toolCallId,'t');assert.equal(tool.status,'failed');
 assert.equal(tool.call_source,null);assert.equal(tool.result_source.entry_id,'result');assert.equal(tool.call_visibility,'not_in_projection');
 assert.equal(JSON.stringify(rows).includes('HIDDEN_COMMAND'),false);
});

test('overview selects active checkpoint and excludes superseded and hidden summaries',()=>{
 const entries=[message('a',null,'user','old task'),
 {type:'compaction',id:'c1',parentId:'a',summary:'SUPERSEDED',firstKeptEntryId:'a',tokensBefore:10},
 message('b','c1','user','retained'),
 {type:'compaction',id:'c2',parentId:'b',summary:'ACTIVE',firstKeptEntryId:'c1',tokensBefore:20},
 {type:'branch_summary',id:'branch',parentId:'c2',fromId:'b',summary:'HIDDEN'},
 {type:'context_edit',id:'hide',parentId:'branch',targetId:'branch',replacement:null},
 message('later','hide','user','latest correction')];
 const records=overview(entries);
 assert.equal(records[0].checkpoint.entry_id,'c2');
 assert.deepEqual(records.filter(r=>r.kind==='checkpoint').map(r=>r.entry_id),['c2']);
 assert.ok(JSON.stringify(records).includes('ACTIVE'));assert.ok(!JSON.stringify(records).includes('SUPERSEDED'));assert.ok(!JSON.stringify(records).includes('HIDDEN'));
 const earlier=recordsFor(data(entries),{view:'overview',leaf_id:'branch'});
 assert.equal(earlier.find(r=>r.kind==='branch_summary').entry_id,'branch');
 assert.equal(earlier[0].checkpoint.entry_id,'c2');
 assert.equal(recordsFor(data(entries),{view:'overview',leaf_id:'b'})[0].checkpoint.entry_id,'c1');
 assert.equal(recordsFor(data(entries),{view:'overview',leaf_id:null})[0].checkpoint,null);
});
test('overview prioritizes current correction, labels initial task and pairs failed then repaired tool calls',()=>{
 const entries=[message('u1',null,'user','OLD_GOAL'),message('a1','u1','assistant','old reply'),
 message('u2','a1','user','NEW_GOAL correction'),
 message('call1','u2','assistant',[{type:'toolCall',id:'bad',name:'bash',arguments:{command:'test'}}]),
 message('fail','call1','toolResult',[{type:'text',text:'HUGE_FAILURE '+ 'x'.repeat(50000)}],{toolCallId:'bad',isError:true}),
 message('call2','fail','assistant',[{type:'toolCall',id:'repair',name:'bash',arguments:{command:'test-fixed'}}]),
 message('ok','call2','toolResult',[{type:'text',text:'repair passed'}],{toolCallId:'repair',isError:false}),
 message('last','ok','assistant',[{type:'text',text:'repair complete'},{type:'toolCall',id:'missing',name:'read',arguments:{path:'fixture'}}])];
 const records=overview(entries),manifest=records[0];
 assert.equal(manifest.checkpoint,null);assert.equal(manifest.initial_task.entry_id,'u1');
 assert.equal(records[1].label,'latest_user');assert.ok(payloadText(records[1]).includes('NEW_GOAL'));
 assert.equal(records[2].label,'latest_assistant');assert.equal(records[2].entry_id,'last');
 assert.equal(records.find(r=>r.entry_id==='u1').label,'initial_task');
 const tools=records.filter(r=>r.kind==='tool_observation');
 assert.deepEqual(tools.map(r=>r.status),['unobserved','succeeded','failed']);
 assert.deepEqual(tools.map(r=>r.result_source?.entry_id??null),[null,'ok','fail']);
 assert.ok(tools.every(r=>Number.isInteger(r.message_index)&&Number.isInteger(r.projection_index)));
 const huge=records.find(r=>r.entry_id==='fail'&&r.kind==='message');
 assert.equal(huge.payload.omitted_char_ranges[0][0],500);
 assert.equal(huge.payload.json_tail_excerpt.length,500);
 assert.equal(huge.payload_source.block_index,0);
 assert.ok(JSON.stringify(records).length<12000);assert.equal(JSON.stringify(records).includes('running'),false);
});
test('overview selection is stable across page budgets and filters, with UTF16 fragments and omitted ranges',()=>{
 const entries=[];let parent=null;
 for(let n=0;n<40;n++){const id='u'+n;entries.push(message(id,parent,'user','中文😀"\\\n'.repeat(300)));parent=id;}
 const snapshot=data(entries),args={session_id:'s',view:'overview'};
 const expected=recordsFor(snapshot,args);
 assert.ok(expected[0].omitted_projection_ranges.length>0);
 const reconstructed=[];let cursor,partial='',pages=0;
 do{
  const page=renderRead(snapshot,{...args,cursor,max_chars:pages%2?333:256,limit:pages%2?2:1});
  let used=0;
  for(const record of page.items){
   if(record.json_fragment!==undefined){assert.equal(record.char_offset,partial.length);partial+=record.json_fragment;used+=record.json_fragment.length;if(partial.length===record.total_chars){reconstructed.push(JSON.parse(partial));partial='';}}
   else{assert.equal(partial,'');reconstructed.push(record);used+=JSON.stringify(record).length;}
  }
  assert.ok(used<=(pages%2?333:256));cursor=page.next_cursor;pages++;
 }while(cursor);
 assert.deepEqual(reconstructed,expected);
 assert.deepEqual(recordsFor(snapshot,{...args,max_chars:32768,limit:50}),expected);
 const filtered=recordsFor(snapshot,{...args,entry_id:'u39'});assert.ok(filtered.every(r=>r.entry_id==='u39'));
 const first=renderRead(snapshot,{...args,max_chars:256});
 assert.throws(()=>renderRead({...snapshot,revision:'changed'},{...args,cursor:first.next_cursor}),/STALE_CURSOR/);
 assert.throws(()=>recordsFor(snapshot,{...args,since:'u0'}),/SINCE_REQUIRES_RAW/);
 assert.throws(()=>recordsFor(snapshot,{...args,leaf_id:'missing'}),/ENTRY_NOT_FOUND/);
 assert.ok(operationSchemas.read.safeParse(args).success);assert.ok(batchSchema.safeParse({operations:[{op:'read',args}]}).success);
});
test('saved, official RPC and attached reads share overview records and distinguish leaf provenance without writes',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-overview-')),cwd=path.join(dir,'project');await fs.mkdir(cwd);
 const config={principal:'overview-fixture',stateDir:path.join(dir,'state'),sessionRoots:[path.join(dir,'sessions')],folders:[{id:'p',path:cwd}],grants:[{folder:cwd,read:true,send:true,new_session:true}],attachmentDir:path.join(dir,'ipc'),...isolatedRuntime(path.join(dir,'agent'))};
 const bridge=await new Bridge(config).init();const original=process.env.PI_MCP_ATTACH_DIR;let shutdown;
 try{
  const made=await bridge.create({folder_id:'p',request_id:'seed'}),saved=await bridge.session(made.session_id);
  const entries=[message('a',null,'user','public task'),message('b','a','assistant','public reply'),message('other',null,'user','other branch')];
  await fs.appendFile(saved.file,entries.map(JSON.stringify).join('\n')+'\n');
  const args={session_id:made.session_id,view:'overview',leaf_id:'b',max_chars:32768};
  const before=await fs.readFile(saved.file,'utf8'),disk=await bridge.read(args);
  assert.equal(bridge.pool.instances.size,0);assert.equal(disk.activity.source,'none');assert.equal(disk.activity.observed_at,null);assert.equal(disk.activity.idle,null);assert.equal(disk.leaf_source,'saved_resume');assert.equal(disk.leaf_selection,'explicit');assert.equal(disk.append_tail,'other');assert.equal(disk.leaf_id,'b');
  assert.equal(await fs.readFile(saved.file,'utf8'),before);
  await bridge.pool.resolve(await bridge.session(made.session_id));
  const rpc=await bridge.read(args);assert.deepEqual(rpc.items,disk.items);assert.equal(rpc.leaf_source,'live');assert.equal(rpc.activity.source,'rpc_get_state');assert.equal(rpc.activity.streaming,false);assert.equal(rpc.activity.pending_messages,false);
  await bridge.pool.stop(made.session_id);
  process.env.PI_MCP_ATTACH_DIR=config.attachmentDir;
  const manager=SessionManager.open(saved.file),handlers={};let idle=true,pending=true;manager.branch('b');
  attachExtension({on:(event,fn)=>{handlers[event]=fn;}});shutdown=handlers.session_shutdown;
  await handlers.session_start({}, {mode:'tui',sessionManager:manager,isIdle:()=>idle,hasPendingMessages:()=>pending,shutdown:()=>{throw new Error('unexpected shutdown');}});
  const session={file:saved.file,header:manager.getHeader()},claim=await readClaim(config.attachmentDir,session),attached=new AttachedRuntime(config,session,claim);
  const attachedResult=await attached.read(args);assert.deepEqual(attachedResult.items,disk.items);assert.equal(attachedResult.leaf_source,'live');assert.equal(attachedResult.leaf_id,'b');assert.equal(attachedResult.activity.scope,'current_runtime');assert.equal(attachedResult.activity.source,'attached_context');assert.equal(attachedResult.activity.idle,true);assert.equal(attachedResult.activity.pending_messages,true);assert.equal(attachedResult.activity.streaming,null);assert.equal(attachedResult.activity.preparing,null);
  const attachedCurrent=await attached.read({...args,leaf_id:undefined});assert.equal(attachedCurrent.leaf_selection,'current');assert.equal(attachedCurrent.leaf_id,'b');assert.equal(attachedCurrent.append_tail,manager.getEntries().at(-1).id);
  idle=false;pending=false;
  const historical=await attached.read({...args,leaf_id:'a'});assert.equal(historical.leaf_id,'a');assert.equal(historical.activity.scope,'current_runtime');assert.equal(historical.activity.idle,false);assert.equal(historical.activity.pending_messages,false);assert.equal(manager.getLeafId(),'b');
  const currentContext=await attached.read({session_id:made.session_id});assert.equal(currentContext.view,'context');assert.ok(currentContext.items[0].message);assert.equal(currentContext.leaf_source,undefined);
  const storageBefore=await fs.readFile(saved.file,'utf8');await attached.read(args);assert.equal(await fs.readFile(saved.file,'utf8'),storageBefore);
  config.grants.push({session_id:made.session_id,read:false});
  const reads=t.mock.method(bridge.pool,'forRead',()=>{throw new Error('must not inspect runtime after read denial');});
  await assert.rejects(bridge.read(args),/NOT_FOUND_OR_DENIED/);assert.equal(reads.mock.calls.length,0);
 }finally{await shutdown?.({reason:'quit'});await bridge.close();if(original===undefined)delete process.env.PI_MCP_ATTACH_DIR;else process.env.PI_MCP_ATTACH_DIR=original;await fs.rm(dir,{recursive:true,force:true});}
});

test('overview pairs results across a user correction and keeps checkpoints under tool pressure',()=>{
 const entries=[message('old',null,'user','initial'),
 message('call','old','assistant',[{type:'toolCall',id:'cross',name:'bash',arguments:{}}]),
 message('new','call','user','correction'),
 message('result','new','toolResult','done',{toolCallId:'cross',isError:false})];
 let records=overview(entries);
 assert.equal(records.find(r=>r.kind==='tool_observation').status,'succeeded');
 assert.equal(records.find(r=>r.kind==='tool_observation').label,'current_group');
 const checkpoint={type:'compaction',id:'checkpoint',parentId:'result',summary:'ACTIVE_CHECKPOINT',firstKeptEntryId:'old',tokensBefore:10};
 entries.push(checkpoint,message('many','checkpoint','assistant',Array.from({length:40},(_,n)=>({type:'toolCall',id:'pending'+n,name:'bash',arguments:{command:'public fixture'}}))));
 records=overview(entries);
 assert.ok(records.some(r=>r.kind==='checkpoint'));assert.ok(records.length<=20);
 assert.ok(records[0].omitted_candidate_records>0);
 assert.ok(records.filter(r=>r.kind==='tool_observation').every(r=>r.status==='unobserved'));
});

test('split-turn compaction retains preceding assistant and failed/repaired tools before the sole new user',()=>{
 const entries=[message('old-user',null,'user','HIDDEN_OLD_GOAL'),
 message('call1','old-user','assistant',[{type:'toolCall',id:'fail-call',name:'bash',arguments:{command:'test'}}]),
 message('result1','call1','toolResult','test failed',{toolCallId:'fail-call',isError:true}),
 message('call2','result1','assistant',[{type:'toolCall',id:'retry-call',name:'bash',arguments:{command:'repair-test'}}]),
 message('result2','call2','toolResult','repair passed',{toolCallId:'retry-call',isError:false}),
 message('conclusion','result2','assistant','retained conclusion'),
 {type:'custom',id:'private-state',parentId:'conclusion',customType:'test-state',data:'RAW_ONLY_STATE'},
 {type:'compaction',id:'split',parentId:'private-state',summary:'current checkpoint',firstKeptEntryId:'call1',tokensBefore:100},
 message('new-user','split','user','NEW_USER_CORRECTION')];
 const records=overview(entries),messages=records.filter(r=>r.kind==='message');
 assert.equal(records[1].entry_id,'new-user');assert.equal(records[1].label,'latest_user');
 assert.equal(records[2].entry_id,'conclusion');assert.equal(records[2].label,'latest_assistant');
 assert.deepEqual(new Set(messages.map(r=>r.entry_id)),new Set(['new-user','conclusion','call1','result1','call2','result2']));
 const tools=records.filter(r=>r.kind==='tool_observation');
 assert.deepEqual(tools.map(r=>r.status),['succeeded','failed']);
 assert.deepEqual(tools.map(r=>r.result_source.entry_id),['result2','result1']);
 assert.ok(tools.every(r=>r.label==='previous_group'));
 assert.deepEqual(records[0].omitted_projection_ranges,[]);assert.equal(records[0].omitted_candidate_records,0);
 assert.equal(JSON.stringify(records).includes('HIDDEN_OLD_GOAL'),false);assert.equal(JSON.stringify(records).includes('RAW_ONLY_STATE'),false);
 assert.ok(JSON.stringify(records).length<12000);
});

test('overview does not render omitted tool-result bodies after reaching its record limit',()=>{
 const entries=[];
 const add=(id,role,content,extra={})=>entries.push({sourceEntry:{id,type:'message'},messages:[{role,content,...extra}]});
 add('initial','user','task');add('old-answer','assistant','previous answer');add('latest','user','new request');
 for(let i=0;i<64;i++)add('result-'+i,'toolResult',[{type:'text',get text(){assert.fail('omitted tool payload must not be rendered');}}],{toolCallId:'call-'+i,isError:false});
 add('answer','assistant','short current answer');
 const records=overviewRecords({entries});
 assert.equal(records.length,20);assert.ok(records.some(r=>r.label==='latest_assistant'));
 assert.ok(records[0].omitted_candidate_records>0);
});
