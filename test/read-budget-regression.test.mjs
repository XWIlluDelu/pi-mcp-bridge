import test from 'node:test';
import assert from 'node:assert/strict';
import {pageRecords} from '../src/data.mjs';
import {rebudgetRead} from '../src/read-page.mjs';
import {executeBatch,BATCH_RESPONSE_LIMIT} from '../src/batch.mjs';

test('mixed escaped records reconstruct exactly across changing page and envelope budgets',t=>{
 const records=Array.from({length:80},(_,i)=>({entry_id:`e${i}`,text:('😀\n\t"\\'+i).repeat([1,15,150,1500][i%4])}));
 const args={session_id:'public-fixture',view:'raw'};
 let cursor,partial='',decoded=[],pages=0;
 do{
  const request={...args,cursor,max_chars:[5000,1500,20000][pages%3],limit:[50,3,7][pages%3]};
  const captured=pageRecords(records,request,'stable');
  const cap=[700,1200,2100,4000][pages%4],output=rebudgetRead(captured,request,cap);
  assert.ok(output);assert.ok(JSON.stringify(output).length<=cap);
  for(const row of output.items){
   if(row.json_fragment!==undefined){
    assert.equal(row.char_offset,partial.length);partial+=JSON.parse(JSON.stringify(row)).json_fragment;
    if(partial.length===row.total_chars){decoded.push(JSON.parse(partial));partial='';}
   }else{assert.equal(partial,'');decoded.push(row);}
  }
  cursor=output.next_cursor;assert.ok(++pages<1000);
 }while(cursor);
 assert.deepEqual(decoded,records);t.diagnostic(`${records.length} mixed records reconstructed across ${pages} bounded pages`);
});

test('mutation receipt survives first or last position beside nine escaped read results',async()=>{
 const rows=[{entry_id:'huge',text:'😀\n\t"\\'.repeat(15000)}],receipt={request_id:'mutate',operation:'send',status:'accepted',disposition:'queued',completion:'not_tracked'};
 for(const position of ['first','last']){
  const reads=Array.from({length:9},(_,i)=>({op:'read',args:{session_id:`s${i}`,view:'raw',max_chars:32768}}));
  const mutation={op:'send',args:{session_id:'mutated',request_id:'mutate',text:'public fixture'}};
  const operations=position==='first'?[mutation,...reads]:[...reads,mutation];
  const result=await executeBatch({read:async args=>pageRecords(rows,args,'fixture'),send:async()=>receipt},{operations});
  assert.ok(JSON.stringify(result).length<=BATCH_RESPONSE_LIMIT);
  assert.deepEqual(result.results.find(row=>row.op==='send').result,receipt);
  for(const row of result.results.filter(row=>row.op==='read')){
   assert.ok(row.result.next_cursor);assert.ok(row.result.items[0].json_fragment.length>0);
  }
 }
});
