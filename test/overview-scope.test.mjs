import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderRead, recordsFor, hash, cursorSignature } from '../src/data.mjs';
import { OVERVIEW_EXTRACTOR_VERSION } from '../src/overview.mjs';
const entries=Array.from({length:30},(_,index)=>({type:'message',id:`u${index}`,parentId:index?`u${index-1}`:null,message:{role:'user',content:`public instruction ${index} `+'x'.repeat(300)}}));
const data={entries,leafId:'u29',revision:hash(entries)};
const args={session_id:'public-fixture',view:'overview'};
test('overview selection scope survives no-match query and entry filters independently of items',()=>{
 const whole=renderRead(data,args);
 for(const filter of [{query:'no-match-public-marker'},{entry_id:'no-such-entry'}]){
  const result=renderRead(data,{...args,...filter,max_chars:256});
  assert.deepEqual(result.items,[]);assert.equal(result.total_items,0);assert.equal(result.next_cursor,null);
  assert.deepEqual(result.overview_scope,whole.overview_scope);
  assert.equal(result.overview_scope.selection,OVERVIEW_EXTRACTOR_VERSION);
  assert.equal(result.overview_scope.filter_scope,'selected_overview_records_only');
  assert.ok(result.overview_scope.omitted_projection_ranges.length);
  assert.equal(result.overview_scope.projection_messages,30);
 }
 const selected=recordsFor(data,args).find(record=>record.entry_id);
 const filtered=renderRead(data,{...args,entry_id:selected.entry_id});
 assert.ok(filtered.items.length);assert.ok(filtered.items.every(item=>item.entry_id===selected.entry_id));
 assert.deepEqual(filtered.overview_scope,whole.overview_scope);
});
test('scope is stable across page budgets and leaf-specific rather than session-wide',()=>{
 const first=renderRead(data,{...args,max_chars:256});assert.ok(first.next_cursor);
 const second=renderRead(data,{...args,cursor:first.next_cursor,max_chars:1000});
 assert.deepEqual(first.overview_scope,second.overview_scope);
 assert.equal(renderRead(data,{...args,leaf_id:'u5'}).overview_scope.projection_messages,6);
 assert.equal(renderRead(data,{...args,leaf_id:null}).overview_scope.projection_messages,0);
});
test('overview cursors bind extractor version while raw and context signatures stay compatible',()=>{
 const page=renderRead(data,{...args,max_chars:256}),cursor=JSON.parse(Buffer.from(page.next_cursor,'base64url'));
 assert.equal(cursor.signature,cursorSignature(args));
 const legacySignature=hash({session_id:args.session_id,view:'overview'});
 for(const signature of [legacySignature,hash({session_id:args.session_id,view:'overview',extractor:'extractive_v1'})]){
  const legacy=Buffer.from(JSON.stringify({...cursor,signature})).toString('base64url');
  assert.throws(()=>renderRead(data,{...args,cursor:legacy,max_chars:1000}),/STALE_CURSOR/);
 }
 for(const view of ['raw','context','summary'])assert.equal(cursorSignature({...args,view}),hash({session_id:args.session_id,view}));
 assert.equal(cursorSignature({session_id:args.session_id}),cursorSignature({...args,view:'context'}));
});
