import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageRecords } from '../src/data.mjs';

const args={session_id:'public-fixture',view:'raw',max_chars:256};
const record=(id,length)=>({entry_id:id,text:'x'.repeat(length)});
const cursor=value=>JSON.parse(Buffer.from(value,'base64url').toString());

test('a record that fits a fresh page stays intact on the next page',()=>{
  const records=[record('one',140),record('two',140),record('three',10)];
  const first=pageRecords(records,args,'revision');
  assert.deepEqual(first.items,[records[0]]);
  assert.equal(cursor(first.next_cursor).index,1);
  assert.equal(cursor(first.next_cursor).offset,0);
  const second=pageRecords(records,{...args,cursor:first.next_cursor},'revision');
  assert.deepEqual(second.items,records.slice(1));assert.equal(second.next_cursor,null);
});

test('oversized records reconstruct exactly and continued fragments finish before intact records',()=>{
  const records=[record('small',100),record('large',700),record('tail',30)];
  let next;const items=[];
  do{
    const result=pageRecords(records,{...args,cursor:next},'revision');
    assert.ok(result.items.length>0);items.push(...result.items);next=result.next_cursor;
  }while(next);
  assert.deepEqual(items[0],records[0]);assert.deepEqual(items.at(-1),records[2]);
  const fragments=items.slice(1,-1);let offset=0;
  for(const fragment of fragments){
    assert.equal(fragment.entry_id,'large');assert.equal(fragment.char_offset,offset);
    assert.equal(fragment.total_chars,JSON.stringify(records[1]).length);
    offset+=fragment.json_fragment.length;
  }
  assert.ok(fragments.length>1);
  assert.deepEqual(JSON.parse(fragments.map(f=>f.json_fragment).join('')),records[1]);
});

test('an existing fragment continues even when a larger new budget could fit its whole record',()=>{
  const value=record('continued',400),first=pageRecords([value],args,'revision');
  const second=pageRecords([value],{...args,max_chars:1000,cursor:first.next_cursor},'revision');
  assert.equal(second.items.length,1);assert.equal(second.items[0].char_offset,256);
  assert.equal(second.next_cursor,null);
  assert.deepEqual(JSON.parse(first.items[0].json_fragment+second.items[0].json_fragment),value);
});

test('Unicode and JSON escaping remain exact through fragment boundaries',()=>{
  const value={entry_id:'unicode',text:'😀漢字\n\t"\\\u0000'.repeat(120)};
  let next,encoded='';let count=0;
  do{
    const result=pageRecords([value],{...args,max_chars:257,cursor:next},'revision');
    const [fragment]=result.items;
    assert.equal(fragment.char_offset,encoded.length);
    // Exercise actual response JSON serialization, including split surrogates.
    encoded+=JSON.parse(JSON.stringify(fragment)).json_fragment;
    next=result.next_cursor;assert.ok(++count<100);
  }while(next);
  assert.equal(encoded,JSON.stringify(value));assert.deepEqual(JSON.parse(encoded),value);
});

test('tiny budgets clamp to the minimum and always make progress',()=>{
  const value=record('tiny-budget',800);let next,encoded='';let pages=0;
  do{
    const result=pageRecords([value],{...args,max_chars:1,limit:0,cursor:next},'revision');
    assert.equal(result.items.length,1);
    const fragment=result.items[0];assert.ok(fragment.json_fragment.length>0&&fragment.json_fragment.length<=256);
    encoded+=fragment.json_fragment;next=result.next_cursor;assert.ok(++pages<10);
  }while(next);
  assert.equal(encoded,JSON.stringify(value));
});

test('pagination retains stale revision and selector checks',()=>{
  const records=[record('one',180),record('two',180)];
  const first=pageRecords(records,args,'revision');
  assert.throws(()=>pageRecords(records,{...args,cursor:first.next_cursor},'changed'),/STALE_CURSOR/);
  for(const change of [{session_id:'other'},{view:'context'},{leaf_id:'other'},{query:'x'}]){
    assert.throws(()=>pageRecords(records,{...args,...change,cursor:first.next_cursor},'revision'),/STALE_CURSOR/);
  }
});
