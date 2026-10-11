import test from 'node:test';
import assert from 'node:assert/strict';
import { executeBatch,BATCH_RESPONSE_LIMIT } from '../src/batch.mjs';
import { pageRecords } from '../src/data.mjs';
import { rebudgetRead } from '../src/read-page.mjs';

const read=session_id=>({op:'read',args:{session_id,view:'raw',max_chars:32768}});
const records=text=>[{entry_id:'entry',text}];
const render=(rows,args)=>({view:args.view??'raw',activity:{state:'idle',source:'fixture'},...pageRecords(rows,args,'public-revision')});

test('ten modest reads retain complete records instead of rigid per-read fragments',async()=>{
 const rows=records('x'.repeat(1075)),calls=[];
 const result=await executeBatch({read:async args=>{calls.push(args);return render(rows,args);}},{operations:Array.from({length:10},(_,i)=>read(`s${i}`))});
 assert.equal(calls.length,10);assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);
 for(const item of result.results){assert.deepEqual(item.result.items,rows);assert.equal(item.result.next_cursor,null);}
});

test('tiny reads release capacity to large escaped reads in either operation order',async()=>{
 const large=records('"\\\n\t😀'.repeat(12000)),tiny=records('tiny');
 for(const reverse of [false,true]){
  const operations=[read('large'),...Array.from({length:9},(_,i)=>read(`tiny${i}`))];if(reverse)operations.reverse();
  let calls=0;
  const result=await executeBatch({read:async args=>{calls++;return render(args.session_id==='large'?large:tiny,args);}},{operations});
  assert.equal(calls,10);assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);
  const index=operations.findIndex(op=>op.args.session_id==='large'),big=result.results[index].result;
  assert.ok(JSON.stringify(big).length>25000,'unused tiny-read shares must reach the large read');
  assert.ok(big.next_cursor);assert.equal(big.items[0].char_offset,0);
  const next=pageRecords(large,{...operations[index].args,cursor:big.next_cursor},'public-revision');
  assert.equal(next.items[0].char_offset,big.items[0].json_fragment.length);
  for(const item of result.results.filter((_,i)=>i!==index))assert.deepEqual(item.result.items,tiny);
 }
});

test('batch reallocates captured snapshots without rereading across a mutation',async()=>{
 let state='before',reads=0;const calls=[];
 const receipt={request_id:'mutate',status:'accepted',completion:'not_tracked'};
 const bridge={
  read:async args=>{reads++;calls.push(`read:${state}`);return render(records(`${state}:`+'x'.repeat(45000)),args);},
  send:async()=>{calls.push('send');state='after';return receipt;},
 };
 const result=await executeBatch(bridge,{operations:[read('same'),{op:'send',args:{session_id:'same',request_id:'mutate',text:'public'}},read('same')]});
 assert.deepEqual(calls,['read:before','send','read:after']);assert.equal(reads,2);
 assert.deepEqual(result.results[1].result,receipt);
 assert.ok(result.results[0].result.items[0].json_fragment.includes('before:'));
 assert.ok(result.results[2].result.items[0].json_fragment.includes('after:'));
 assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);
});

test('small batches snapshot shared read objects before later mutations even without resizing',async()=>{
 const shared=render(records('before'),{session_id:'same',view:'raw'});
 const bridge={read:async()=>shared,send:async()=>{shared.items[0].text='after';shared.activity.state='streaming';return {status:'accepted'};}};
 const result=await executeBatch(bridge,{operations:[read('same'),{op:'send',args:{session_id:'same',request_id:'mutate',text:'public'}},read('same')]});
 assert.equal(result.results[0].result.items[0].text,'before');
 assert.equal(result.results[0].result.activity.state,'idle');
 assert.equal(result.results[2].result.items[0].text,'after');
 assert.equal(result.results[2].result.activity.state,'streaming');
 assert.ok(JSON.stringify(result).length<BATCH_RESPONSE_LIMIT);
});

test('snapshot resizing preserves complete records, scope and cursor continuation',()=>{
 const rows=Array.from({length:4},(_,i)=>({entry_id:`e${i}`,text:'x'.repeat(800)}));
 const args={session_id:'s',view:'raw',max_chars:32768};
 const captured={...render(rows,args),overview_scope:{filter_scope:'selected_overview_records_only',omitted_ranges:[]}};
 const reduced=rebudgetRead(captured,args,1500);
 assert.deepEqual(reduced.items,[rows[0]]);assert.deepEqual(reduced.overview_scope,captured.overview_scope);
 assert.deepEqual(reduced.activity,captured.activity);assert.equal(reduced.revision,captured.revision);
 const next=pageRecords(rows,{...args,cursor:reduced.next_cursor},captured.revision);
 assert.deepEqual(next.items,rows.slice(1));
 assert.equal(captured.items.length,4);
});

test('resizing a captured fragment continuation retains absolute character offsets',()=>{
 const rows=records('"\\'.repeat(30000)),args={session_id:'s',view:'raw',max_chars:1200};
 const first=render(rows,args),continuedArgs={...args,cursor:first.next_cursor};
 const captured=render(rows,continuedArgs),reduced=rebudgetRead(captured,continuedArgs,1000);
 const part=reduced.items[0];
 assert.equal(part.char_offset,first.items[0].json_fragment.length);
 assert.ok(JSON.stringify(reduced).length<=1000);
 const next=pageRecords(rows,{...args,cursor:reduced.next_cursor},captured.revision);
 assert.equal(next.items[0].char_offset,part.char_offset+part.json_fragment.length);
 assert.equal(part.json_fragment,JSON.stringify(rows[0]).slice(part.char_offset,part.char_offset+part.json_fragment.length));
});
