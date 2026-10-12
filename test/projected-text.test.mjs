import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {Bridge} from '../src/bridge.mjs';
import {makeServer} from '../src/server.mjs';
import {renderRead,hash,cursorSignature,fitDecodedText} from '../src/data.mjs';
import {rebudgetRead} from '../src/read-page.mjs';
import {BATCH_RESPONSE_LIMIT} from '../src/batch.mjs';
import {reserveHostSession} from '../src/host-adapter.mjs';
import {reserveOwner,updateOwner,releaseOwner} from '../src/attachments.mjs';
import {readSchema,batchSchema} from '../src/tool-schemas.mjs';

const message=(id,parentId,content,role='assistant')=>({type:'message',id,parentId,message:{role,content}});
const snapshot=(entries,leafId=entries.at(-1)?.id??null)=>({entries,leafId,revision:hash(entries)});
async function fixture(t,entries){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pi-text-read-')),cwd=path.join(dir,'project');
 await fs.mkdir(cwd);
 const config={principal:'text-fixture',stateDir:path.join(dir,'state'),attachmentDir:path.join(dir,'ipc'),
  sessionRoots:[path.join(dir,'sessions')],folders:[{id:'project',path:cwd}],grants:[{folder:cwd,read:true,new_session:true}]};
 const bridge=await new Bridge(config).init(),made=await bridge.create({folder_id:'project',request_id:'seed'}),saved=await bridge.session(made.session_id);
 await fs.appendFile(saved.file,entries.map(JSON.stringify).join('\n')+'\n');
 const server=makeServer(bridge),client=new Client({name:'projected-text-fixture',version:'1'}),[remote,local]=InMemoryTransport.createLinkedPair();
 await server.connect(local);await client.connect(remote);
 const cleanup=[];
 t.after(async()=>{for(const close of cleanup)await close();await client.close();await server.close();await bridge.close();await fs.rm(dir,{recursive:true,force:true});});
 const call=(args)=>client.callTool({name:'read',arguments:{session_id:made.session_id,...args}});
 const ok=async args=>{const result=await call(args);assert.ok(!result.isError,JSON.stringify(result));return result.structuredContent;};
 const error=async(args,code)=>{const result=await call(args);assert.equal(result.isError,true);assert.equal(result.content[0].text,code);};
 return {config,bridge,client,saved,entries,id:made.session_id,call,ok,error,cleanup};
}


test('MCP pages native persisted system sections without flattening empty content or tool metadata',async t=>{
 const text='Checkpoint decision 😀 "\n\\ '.repeat(180);
 const entries=[message('kept',null,'retained work','user'),
  {type:'compaction',id:'checkpoint',parentId:'kept',summary:'marker only',firstKeptEntryId:'kept',tokensBefore:20,
   systemMessage:{role:'system',content:'',sections:{project_context:text,rules:'synthetic rule',removed:null,empty:''},
    toolsAdded:[{name:'synthetic_tool',description:'SYNTHETIC_TOOL_METADATA_'.repeat(5000),parameters:{type:'object'}}],timestamp:0}}];
 const f=await fixture(t,entries),args={entry_id:'checkpoint',message_index:0,field:'sections',section:'project_context',text_offset:23};
 let cursor,decoded='',pages=0;
 do{
  const budget=pages%2?384:256,p=await f.ok({...args,cursor,max_chars:budget}),item=p.items[0];
  assert.equal(p.format,'projected_text');assert.equal(item.field,'sections');assert.equal(item.section,'project_context');
  assert.equal(item.entry_id,'checkpoint');assert.equal(item.message_index,0);assert.ok(!('block_index' in item));
  assert.equal(item.text_offset,23+decoded.length);assert.equal(item.total_text_units,text.length);
  assert.ok(JSON.stringify(item).length<=budget);assert.ok(item.text.isWellFormed());
  assert.ok(!JSON.stringify(p).includes('SYNTHETIC_TOOL_METADATA'));
  decoded+=item.text;cursor=p.next_cursor;assert.ok(++pages<200);
 }while(cursor);
 assert.equal(decoded,text.slice(23));
 const emptyContent=await f.ok({entry_id:'checkpoint',message_index:0});
 assert.equal(emptyContent.items[0].field,'content');assert.equal(emptyContent.items[0].text,'');
 assert.equal((await f.ok({...args,section:'empty',text_offset:0})).items[0].text,'');
 await f.error({...args,section:'removed',text_offset:0},'NON_TEXT_CONTENT');
 for(const section of ['absent','toolsAdded','toString'])await f.error({...args,section},'TEXT_SECTION_NOT_FOUND');
 for(const invalid of [
  {entry_id:'checkpoint',message_index:0,field:'sections'},
  {...args,block_index:0},{...args,field:'content'},{...args,view:'raw'},{...args,view:'status'},
  {section:'rules'},{field:'sections',section:'rules'}
 ])await f.error(invalid,'INVALID_TEXT_SELECTOR');
 assert.equal(readSchema.safeParse({session_id:f.id,...args,field:'toolsAdded'}).success,false);
 assert.equal(batchSchema.safeParse({operations:[{op:'read',args:{session_id:f.id,...args,block_index:0}}]}).success,false);
 const raw=await f.ok({view:'raw',entry_id:'checkpoint',max_chars:512});
 assert.equal(raw.format,undefined);assert.ok(raw.items[0].json_fragment.includes('systemMessage'));
 assert.equal(f.bridge.pool.instances.size,0);
});

test('section selection follows native context edits and preserves section deltas, cursor binding and captured budgets',async t=>{
 const sections={project_context:'ORIGINAL_SECTION '.repeat(200),rules:'RULE_TEXT'};
 const entries=[message('kept',null,'work','user'),
  {type:'compaction',id:'checkpoint',parentId:'kept',summary:'marker',firstKeptEntryId:'kept',tokensBefore:20,systemMessage:{role:'system',content:'',sections,timestamp:0}},
  {type:'context_edit',id:'replace-system',parentId:'checkpoint',targetId:'checkpoint',replacement:{content:'NOT_NATIVE_SYSTEM_REPLACEMENT'}},
  message('edited','replace-system',[{type:'text',text:'ORIGINAL_ASSISTANT'}]),
  {type:'context_edit',id:'replace-assistant',parentId:'edited',targetId:'edited',replacement:{content:'EFFECTIVE_ASSISTANT'}},
  message('update','replace-assistant','', 'system')];
 entries.at(-1).message.sections={project_context:'UPDATED_SECTION',rules:null};
 const f=await fixture(t,entries),args={session_id:f.id,entry_id:'checkpoint',message_index:0,field:'sections',section:'project_context',max_chars:256};
 const first=await f.ok(args);assert.ok(first.next_cursor);
 // Pi ignores non-null replacements for system messages; do not invent a replacement or merge later deltas.
 assert.ok(first.items[0].text.startsWith('ORIGINAL_SECTION'));
 assert.equal((await f.ok({entry_id:'edited',message_index:0,block_index:0})).items[0].text,'EFFECTIVE_ASSISTANT');
 const delta=await f.ok({...args,entry_id:'update'});assert.equal(delta.items[0].text,'UPDATED_SECTION');
 await f.error({...args,entry_id:'update',section:'rules'},'NON_TEXT_CONTENT');
 await f.error({...args,entry_id:'edited'},'NON_TEXT_CONTENT');
 for(const change of [{section:'rules'},{field:'content',section:undefined},{leaf_id:'replace-system'},{entry_id:'update'}])
  await f.error({...args,...change,cursor:first.next_cursor},'STALE_CURSOR');
 const data=snapshot(entries),captured=renderRead(data,{...args,max_chars:1500}),reduced=rebudgetRead(captured,args,1200);
 assert.ok(reduced);assert.ok(JSON.stringify(reduced).length<=1200);assert.equal(reduced.items[0].section,args.section);
 const next=renderRead(data,{...args,cursor:reduced.next_cursor});
 assert.equal(next.items[0].text_offset,reduced.items[0].text.length);
 assert.equal(next.items[0].text,sections.project_context.slice(next.items[0].text_offset,next.items[0].text_offset+next.items[0].text.length));
 const hide={type:'context_edit',id:'hide-checkpoint',parentId:'update',targetId:'checkpoint',replacement:null};
 await fs.appendFile(f.saved.file,JSON.stringify(hide)+'\n');
 await f.error({...args,cursor:first.next_cursor},'STALE_CURSOR');
 await f.error(args,'PROJECTED_MESSAGE_NOT_FOUND');
 assert.equal((await f.ok({...args,leaf_id:'update'})).items[0].text,first.items[0].text);
 f.config.grants.push({session_id:f.id,read:false});
 await f.error(args,'NOT_FOUND_OR_DENIED');
});

test('MCP rejects legacy ignored selectors and misbound owner replies while ordinary read stays usable',async t=>{
 const entries=[message('system',null,'', 'system')];
 entries[0].message.sections={rules:'SECTION_TEXT',project_context:'LONG_SECTION '.repeat(200)};
 const f=await fixture(t,entries),record=await reserveOwner(f.config.attachmentDir,f.saved,'host');
 let mode='legacy',tamper;
 const server=net.createServer(socket=>{
  socket.setEncoding('utf8');let bytes='';
  socket.on('data',chunk=>{
   bytes+=chunk;if(!bytes.includes('\n'))return;
   const request=JSON.parse(bytes.slice(0,bytes.indexOf('\n')));
   assert.equal(request.generation,record.generation);
   let body;
   if(request.op==='state')body={sessionFile:f.saved.file,sessionId:f.saved.header.id};
   else if(mode==='error'){socket.end(JSON.stringify({generation:record.generation,error:'RUNTIME_SESSION_CHANGED'})+'\n');return;}
   else{
    const args={...request.body};
    if(mode==='legacy')for(const key of ['message_index','block_index','text_offset','field','section'])delete args[key];
    if(mode==='content-only'){delete args.field;delete args.section;}
    body=renderRead(snapshot(entries),args,{leafSource:'live',generation:record.generation});
    if(mode==='content-only')delete body.items[0].field; // c942 content expansion has no field provenance.
    tamper?.(body);
   }
   socket.end(JSON.stringify({generation:record.generation,data:body})+'\n');
  });
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(record.socket,resolve);});
 await updateOwner(f.config.attachmentDir,f.saved,record,{phase:'ready'});
 f.cleanup.push(async()=>{await new Promise(resolve=>server.close(resolve));await releaseOwner(f.config.attachmentDir,f.saved,record);});
 assert.ok((await f.ok({entry_id:'system'})).items[0].message.sections);
 const args={entry_id:'system',message_index:0,field:'sections',section:'rules'};
 await f.error({entry_id:'system',message_index:0},'OWNER_READ_REFRESH_REQUIRED');
 await f.error(args,'OWNER_READ_REFRESH_REQUIRED');
 const batch=await f.client.callTool({name:'batch',arguments:{operations:[{op:'read',args:{session_id:f.id,...args}},{op:'read',args:{session_id:f.id,entry_id:'system'}}]}});
 assert.equal(batch.structuredContent.results[0].error.code,'OWNER_READ_REFRESH_REQUIRED');
 assert.ok(batch.structuredContent.results[1].result.items[0].message.sections);
 mode='content-only';
 assert.equal((await f.ok({entry_id:'system',message_index:0})).items[0].text,''); // Existing precise content owner remains compatible.
 await f.error(args,'OWNER_READ_REFRESH_REQUIRED');
 mode='current';assert.equal((await f.ok(args)).items[0].text,'SECTION_TEXT');
 for(const mutate of [
  r=>{r.items[0].entry_id='other';},r=>{r.items[0].message_index=1;},
  r=>{r.items[0].section='project_context';},r=>{r.items[0].field='content';},
  r=>{r.items[0].text_offset=1;},r=>{r.items[0].total_text_units=0;},
  r=>{r.next_cursor='not a cursor';},r=>{r.items=[];},r=>{r.items=null;},r=>{r.leaf_id='other';}
 ]){
  tamper=mutate;await f.error({...args,leaf_id:'system'},'OWNER_READ_REFRESH_REQUIRED');
 }
 tamper=undefined;
 const longArgs={...args,section:'project_context',max_chars:256},page=await f.ok(longArgs);
 const continuation=await f.ok({...longArgs,cursor:page.next_cursor});
 assert.equal(continuation.items[0].text_offset,page.items[0].text.length);
 mode='error';await f.error(args,'RUNTIME_SESSION_CHANGED');
 assert.ok([...f.bridge.pool.instances.values()].every(runtime=>runtime.attached));
});

test('MCP reads a later text block directly without expanding an opaque first block',async t=>{
 const opaque='SYNTHETIC_OPAQUE_'.repeat(100000);
 const entries=[message('request',null,'fixture request','user'),
  message('reply','request',[{type:'thinking',thinking:'synthetic thought',thinkingSignature:opaque},{type:'text',text:'SHORT_LATER_ANSWER'}])];
 const f=await fixture(t,entries),before=await fs.readFile(f.saved.file,'utf8');
 const tools=(await f.client.listTools()).tools;
 assert.equal(tools.length,6);
 for(const key of ['message_index','block_index','text_offset','field','section'])assert.ok(tools.find(tool=>tool.name==='read').inputSchema.properties[key]);
 const overview=await f.ok({view:'overview'}),locator=overview.items.find(item=>item.label==='latest_assistant');
 assert.deepEqual(locator.payload_source,{field:'content',block_index:1,block_field:'text'});
 const read=await f.ok({entry_id:locator.entry_id,message_index:locator.message_index,block_index:locator.payload_source.block_index,max_chars:256});
 assert.equal(read.format,'projected_text');assert.equal(read.offset_unit,'utf16_code_units');
 assert.equal(read.items[0].text,'SHORT_LATER_ANSWER');assert.equal(read.next_cursor,null);
 assert.ok(JSON.stringify(read.items[0]).length<=256);assert.ok(!JSON.stringify(read).includes('SYNTHETIC_OPAQUE'));
 t.diagnostic(`opaque block: ${opaque.length} units; selected item: ${JSON.stringify(read.items[0]).length} serialized characters`);
 const raw=await f.ok({view:'raw',entry_id:'reply',max_chars:256});
 assert.ok(raw.items[0].json_fragment.includes('SYNTHETIC_OPAQUE'));assert.ok(!('kind' in JSON.parse(Buffer.from(raw.next_cursor,'base64url').toString())));
 assert.equal(await fs.readFile(f.saved.file,'utf8'),before);assert.equal(f.bridge.pool.instances.size,0);
});

test('MCP pages decoded middle text in UTF16 units with escapes and whole surrogate pairs',async t=>{
 const prefix='irrelevant prefix '.repeat(1000),text=prefix+'MIDDLE_EVIDENCE 😀 é "\n\\ '.repeat(30)+'end';
 const f=await fixture(t,[message('middle',null,[{type:'text',text}])]);
 const args={entry_id:'middle',message_index:0,block_index:0,text_offset:prefix.length};
 let cursor,decoded='',pages=0;
 do{
  const budget=pages%2?350:256,read=await f.ok({...args,cursor,max_chars:budget}),item=read.items[0];
  assert.equal(item.text_offset,prefix.length+decoded.length);assert.equal(item.total_text_units,text.length);
  assert.ok(item.text.isWellFormed());assert.ok(JSON.stringify(item).length<=budget);assert.ok(!('json_fragment' in item));
  decoded+=item.text;cursor=read.next_cursor;assert.ok(++pages<30);
 }while(cursor);
 assert.equal(decoded,text.slice(prefix.length));assert.ok(decoded.includes('\n'));assert.ok(decoded.includes('😀'));
 const wrap=text=>({text});assert.equal(fitDecodedText('😀',JSON.stringify(wrap('😀')).length,wrap),2);
 await f.error({...args,text_offset:text.length+1},'INVALID_TEXT_OFFSET');
 const pair=await fixture(t,[message('pair',null,'A😀Z','user'),message('empty','pair','')]);
 await pair.error({entry_id:'pair',message_index:0,text_offset:2},'INVALID_TEXT_OFFSET');
 await pair.error({entry_id:'pair',message_index:0,block_index:0},'INVALID_TEXT_SELECTOR');
 assert.equal((await pair.ok({entry_id:'pair',message_index:0,text_offset:3})).items[0].text,'Z');
 assert.equal((await pair.ok({entry_id:'empty',message_index:0})).items[0].text,'');
});

test('MCP text selection respects replacement, hidden content, branch and checkpoint message locators',async t=>{
 const entries=[message('request',null,'task','user'),
  message('edited','request',[{type:'text',text:'ORIGINAL_PRIVATE_MARKER'}]),
  message('hidden','edited',[{type:'text',text:'HIDDEN_PRIVATE_MARKER'}]),
  {type:'context_edit',id:'replace',parentId:'hidden',targetId:'edited',replacement:{content:[{type:'thinking',thinkingSignature:'SYNTHETIC_OPAQUE'}, {type:'text',text:'PROJECTED_REPLACEMENT'}]}},
  {type:'context_edit',id:'hide',parentId:'replace',targetId:'hidden',replacement:null},
  {type:'compaction',id:'checkpoint',parentId:'hide',summary:'checkpoint titles',firstKeptEntryId:'edited',tokensBefore:20,systemMessage:{role:'system',content:'PERSISTED_CHECKPOINT_SEMANTICS',timestamp:0}}];
 const f=await fixture(t,entries);
 assert.equal((await f.ok({entry_id:'edited',message_index:0,block_index:1})).items[0].text,'PROJECTED_REPLACEMENT');
 await f.error({entry_id:'hidden',message_index:0,block_index:0},'PROJECTED_MESSAGE_NOT_FOUND');
 assert.equal((await f.ok({entry_id:'checkpoint',message_index:0})).items[0].text,'PERSISTED_CHECKPOINT_SEMANTICS');
 assert.equal((await f.ok({entry_id:'edited',message_index:0,block_index:0,leaf_id:'hidden'})).items[0].text,'ORIGINAL_PRIVATE_MARKER');
 const raw=await f.ok({view:'raw',entry_id:'edited'});assert.equal(raw.items[0].entry.message.content[0].text,'ORIGINAL_PRIVATE_MARKER');
});

test('MCP rejects unsupported or misbound selectors without raw fallback',async t=>{
 const f=await fixture(t,[message('one',null,[{type:'thinking',thinking:'not content text'},{type:'image',data:'SYNTHETIC_IMAGE',mimeType:'image/png'},{type:'text',text:'valid'}])]);
 await f.error({entry_id:'one',message_index:0,block_index:0},'NON_TEXT_CONTENT');
 await f.error({entry_id:'one',message_index:0,block_index:1},'NON_TEXT_CONTENT');
 await f.error({entry_id:'one',message_index:0},'NON_TEXT_CONTENT');
 await f.error({entry_id:'one',message_index:0,block_index:9},'TEXT_BLOCK_NOT_FOUND');
 await f.error({entry_id:'one',message_index:1,block_index:2},'PROJECTED_MESSAGE_NOT_FOUND');
 await f.error({entry_id:'absent',message_index:0,block_index:2},'PROJECTED_MESSAGE_NOT_FOUND');
 for(const invalid of [{message_index:0},{entry_id:'one',block_index:2},{entry_id:'one',text_offset:0},
  {view:'raw',entry_id:'one',message_index:0},{view:'overview',entry_id:'one',message_index:0},
  {entry_id:'one',message_index:0,query:'valid'}]){
  await f.error(invalid,'INVALID_TEXT_SELECTOR');
 }
 assert.equal((await f.ok({entry_id:'one',message_index:0,block_index:2,limit:1})).items[0].text,'valid');
 for(const invalid of [{message_index:-1},{message_index:0.5},{message_index:0,block_index:1.5},{message_index:0,text_offset:Number.MAX_SAFE_INTEGER+1}]){
  assert.equal(readSchema.safeParse({session_id:f.id,entry_id:'one',...invalid}).success,false);
  assert.equal(batchSchema.safeParse({operations:[{op:'read',args:{session_id:f.id,entry_id:'one',...invalid}}]}).success,false);
 }
});

test('text cursors bind revision, actual leaf and selectors; legacy signatures stay unchanged',async t=>{
 const entries=[message('a',null,'a'.repeat(1000),'user'),message('b','a',[{type:'text',text:'b'.repeat(1000)},{type:'text',text:'other'}])],f=await fixture(t,entries);
 const args={entry_id:'b',message_index:0,block_index:0,max_chars:256};
 const first=await f.ok(args),cursor=first.next_cursor;assert.ok(cursor);
 for(const changed of [{entry_id:'a',block_index:undefined},{message_index:1},{block_index:1},{text_offset:1},{leaf_id:'a'}, {message_index:undefined,block_index:undefined}]){
  await f.error({...args,...changed,cursor},'STALE_CURSOR');
 }
 const raw=await f.ok({view:'raw',entry_id:'b',max_chars:256});
 await f.error({...args,cursor:raw.next_cursor},'STALE_CURSOR');
 const data=snapshot(entries),renderArgs={session_id:f.id,...args};
 const textPage=renderRead(data,renderArgs);
 assert.throws(()=>renderRead({...data,leafId:'a'},{...renderArgs,cursor:textPage.next_cursor}),/STALE_CURSOR/);
 // Same selected source on another leaf must also invalidate the cursor even with an unchanged revision.
 const aArgs={session_id:f.id,entry_id:'a',message_index:0,max_chars:256},aPage=renderRead(data,aArgs);
 assert.throws(()=>renderRead({...data,leafId:'a'},{...aArgs,cursor:aPage.next_cursor}),/STALE_CURSOR/);
 await fs.appendFile(f.saved.file,JSON.stringify(message('new','b','changed leaf','user'))+'\n');
 await f.error({...args,cursor},'STALE_CURSOR');
 assert.equal(cursorSignature({session_id:'s',view:'context',entry_id:'a'}),hash({session_id:'s',view:'context',entry_id:'a',since:undefined,query:undefined,leaf_id:undefined}));
});

test('permission is checked before projected content or runtime inspection',async t=>{
 const f=await fixture(t,[message('a',null,'PRIVATE_FIXTURE_ONLY')]);
 f.config.grants.push({session_id:f.id,read:false});
 const reads=t.mock.method(f.bridge.pool,'forRead',()=>{throw new Error('must not inspect content');});
 await f.error({entry_id:'a',message_index:0},'NOT_FOUND_OR_DENIED');
 await f.error({entry_id:'a',block_index:0},'NOT_FOUND_OR_DENIED');assert.equal(reads.mock.calls.length,0);
});

test('live host and saved reads share text rendering and preserve selector errors',async t=>{
 const system=message('s','a','', 'system');system.message.sections={project_context:'LIVE_SECTION 😀 '.repeat(40)};
 const entries=[message('a',null,[{type:'thinking',thinkingSignature:'SYNTHETIC_OPAQUE'},{type:'text',text:'live answer'}]),system],f=await fixture(t,entries);
 const args={entry_id:'a',message_index:0,block_index:1},disk=await f.ok(args);
 const controller=await reserveHostSession({attachmentDir:f.config.attachmentDir,session:f.saved});
 f.cleanup.push(()=>controller.close());
 await controller.ready({state:async()=>({sessionFile:f.saved.file,sessionId:f.saved.header.id,isStreaming:false}),
  snapshot:async()=>({sessionFile:f.saved.file,sessionId:f.saved.header.id,entries,leafId:'s'}),submit:async()=>{throw new Error('unused');}});
 const live=await f.ok(args);assert.deepEqual(live.items,disk.items);assert.equal(live.format,'projected_text');
 await f.error({...args,block_index:0},'NON_TEXT_CONTENT');
 const sectionArgs={entry_id:'s',message_index:0,field:'sections',section:'project_context',max_chars:256};
 const section=await f.ok(sectionArgs);assert.equal(section.items[0].field,'sections');assert.ok(section.next_cursor);
 const next=await f.ok({...sectionArgs,cursor:section.next_cursor});
 assert.equal(next.items[0].text_offset,section.items[0].text.length);
 await f.error({...sectionArgs,section:'absent'},'TEXT_SECTION_NOT_FOUND');
});

test('batch rebudgeting pages decoded text from captured observations without rereading',async t=>{
 const text='😀"\\\n é '.repeat(5000),entries=[message('a',null,[{type:'text',text}])],f=await fixture(t,entries);
 const args={session_id:f.id,entry_id:'a',message_index:0,block_index:0,max_chars:32768};
 const reads=t.mock.method(f.bridge,'read',f.bridge.read.bind(f.bridge));
 const result=await f.client.callTool({name:'batch',arguments:{operations:Array.from({length:10},()=>({op:'read',args}))}});
 assert.ok(!result.isError,JSON.stringify(result));const batch=result.structuredContent;
 assert.equal(reads.mock.calls.length,10);assert.ok(JSON.stringify(batch).length<=BATCH_RESPONSE_LIMIT);
 for(const row of batch.results){
  assert.equal(row.result.format,'projected_text');assert.ok(row.result.items[0].text.length>0);
  const next=await f.ok({...args,cursor:row.result.next_cursor,max_chars:256});
  assert.equal(next.items[0].text_offset,row.result.items[0].text.length);
 }
 let cursor,decoded='',pages=0;
 do{
  const request={...args,cursor,max_chars:1500},captured=renderRead(snapshot(entries),request),reduced=rebudgetRead(captured,request,1200);
  assert.ok(reduced);assert.ok(JSON.stringify(reduced).length<=1200);
  assert.equal(reduced.items[0].text_offset,decoded.length);assert.ok(reduced.items[0].text.isWellFormed());
  decoded+=reduced.items[0].text;cursor=reduced.next_cursor;assert.ok(++pages<1000);
 }while(cursor);
 assert.equal(decoded,text);
});
