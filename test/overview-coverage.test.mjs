import {test} from 'node:test';
import assert from 'node:assert/strict';
import {overviewRecords} from '../src/overview.mjs';
function projection(messages){return {entries:messages.map((message,index)=>({sourceEntry:{id:`e${index}`,type:'message'},messages:[message]}))};}
const user=content=>({role:'user',content});
const text=content=>({role:'assistant',content:[{type:'text',text:content}]});

test('short selected blocks donate their unused excerpt capacity to longer blocks',()=>{
  for(const texts of [['brief','x'.repeat(4000),'done'],['x'.repeat(4000),'brief','y'.repeat(4000)]]){
    const content=texts.map(text=>({type:'text',text}));
    const row=overviewRecords(projection([{role:'assistant',content}])).find(row=>row.label==='latest_assistant');
    const blocks=[row,...row.additional_text_blocks];
    assert.deepEqual(blocks.map(block=>block.payload_source.block_index),[0,2,1]);
    let used=0;
    for(const {payload,payload_source} of blocks){
      const json=JSON.stringify(texts[payload_source.block_index]);
      if(payload.value!==undefined){used+=JSON.stringify(payload.value).length;assert.equal(payload.value,texts[payload_source.block_index]);}
      else{
        used+=payload.json_excerpt.length+payload.json_tail_excerpt.length;
        assert.equal(payload.json_excerpt,json.slice(0,payload.omitted_char_ranges[0][0]));
        assert.equal(payload.json_tail_excerpt,json.slice(payload.tail_char_offset));
        assert.deepEqual(payload.omitted_char_ranges,[[payload.json_excerpt.length,payload.tail_char_offset]]);
      }
    }
    assert.equal(used,1000);
    assert.deepEqual(overviewRecords(projection([{role:'assistant',content}])).find(row=>row.label==='latest_assistant'),row);
  }
});

test('interior instruction and correction survive a tool flood and final continue',t=>{
  const messages=[user('PUBLIC_INITIAL_DIRECTION'),text('initial response'),user('PUBLIC_INTERIOR_INSTRUCTION'),text('interior response'),user('PUBLIC_LATER_CORRECTION')];
  for(let i=0;i<100;i++)messages.push({role:'assistant',content:[{type:'toolCall',id:`t${i}`,name:'bash',arguments:{command:`PUBLIC_TOOL_${i}`}}]},
    {role:'toolResult',toolCallId:`t${i}`,isError:false,content:'PUBLIC_RESULT '.repeat(1000)});
  messages.push(user('continue'),text('PUBLIC_FINAL_CONCLUSION'));
  const rows=overviewRecords(projection(messages)),serialized=JSON.stringify(rows);
  for(const marker of ['PUBLIC_INITIAL_DIRECTION','PUBLIC_INTERIOR_INSTRUCTION','PUBLIC_LATER_CORRECTION','PUBLIC_FINAL_CONCLUSION'])assert.ok(serialized.includes(marker),marker);
  assert.equal(rows[0].selection,'extractive_v3');assert.equal(rows[0].user_coverage.selected,4);
  assert.ok(rows.some(row=>row.kind==='tool_observation'));
  assert.ok(rows.length<=20);assert.ok(JSON.stringify(rows.slice(1)).length<=10000+rows.length);
  t.diagnostic(`Recovered 4/4 user messages plus final assistant; ${rows.length-1} selected records; ${serialized.length} serialized UTF-16 chars including manifest.`);
});
test('head/tail text excerpts and multiple blocks retain exact source and omission ranges',()=>{
  const first='PUBLIC_FIRST '+ 'x'.repeat(4000)+' PUBLIC_FIRST_TAIL',last='PUBLIC_LAST '+ 'y'.repeat(4000)+' PUBLIC_FINAL_CONCLUSION';
  const content=[{type:'thinking',thinking:'PRIVATE_THINKING'},{type:'text',text:first},{type:'text',text:'PUBLIC_INTERIOR_BLOCK'},
    {type:'thinking',thinking:'PRIVATE_THINKING'},{type:'text',text:last}];
  const rows=overviewRecords(projection([user('task'),{role:'assistant',content}]));
  const row=rows.find(row=>row.label==='latest_assistant'),blocks=[row,...row.additional_text_blocks];
  assert.deepEqual(blocks.map(block=>block.payload_source.block_index),[1,4,2]);
  for(const block of blocks){
    const original=content[block.payload_source.block_index].text,payload=block.payload,json=JSON.stringify(original);
    if(payload.value!==undefined){assert.equal(payload.value,original);continue;}
    assert.equal(payload.json_excerpt,json.slice(0,payload.omitted_char_ranges[0][0]));
    assert.equal(payload.json_tail_excerpt,json.slice(payload.tail_char_offset));
    assert.deepEqual(payload.omitted_char_ranges,[[payload.json_excerpt.length,payload.tail_char_offset]]);
    assert.equal(payload.total_chars,json.length);
  }
  assert.deepEqual(row.omitted_content_block_ranges,[[0,1],[3,4]]);assert.equal(row.omitted_content_block_count,2);
  assert.ok(JSON.stringify(row).includes('PUBLIC_FIRST_TAIL'));assert.ok(JSON.stringify(row).includes('PUBLIC_FINAL_CONCLUSION'));
  assert.ok(!JSON.stringify(row).includes('PRIVATE_THINKING'));
});
test('positional coverage spreads across a long user timeline independent of surrounding tool count',t=>{
  const messages=[];
  for(let i=0;i<40;i++)messages.push(user(`PUBLIC_DIRECTION_${i} `+'x'.repeat(3000)));
  messages.push(text('conclusion'));
  const rows=overviewRecords(projection(messages)),selected=rows.filter(row=>row.role==='user').map(row=>row.projection_index);
  assert.ok(selected.includes(0));assert.ok(selected.includes(19));assert.ok(selected.includes(38));assert.ok(selected.includes(39));
  assert.ok(selected.some(index=>index>0&&index<19));assert.ok(selected.some(index=>index>19&&index<38));
  assert.ok(rows[0].omitted_projection_ranges.length);assert.equal(rows[0].user_coverage.selected,selected.length);
  assert.deepEqual(overviewRecords(projection(messages)),rows);
  t.diagnostic(`Selected user indices ${selected.join(',')}; ${JSON.stringify(rows).length} serialized UTF-16 chars including manifest.`);
});
test('omitted text blocks stay addressable when block count exceeds the sampling budget',()=>{
  const content=Array.from({length:1000},(_,index)=>({type:'text',text:`PUBLIC_BLOCK_${index}`}));
  const row=overviewRecords(projection([user('task'),{role:'assistant',content}])).find(row=>row.label==='latest_assistant');
  assert.deepEqual([row,...row.additional_text_blocks].map(block=>block.payload_source.block_index),[0,999,499]);
  assert.deepEqual(row.omitted_content_block_ranges,[[1,499],[500,999]]);
  assert.equal(row.omitted_content_block_count,997);assert.ok(JSON.stringify(row).length<1200);
});

test('native user and tool-result text arrays preserve trailing content without metadata',()=>{
  const messages=[{role:'user',content:[{type:'text',text:'PUBLIC_START '+ 'x'.repeat(4000)+' PUBLIC_TRAILING_CORRECTION'}],privateMetadata:'OMIT_PRIVATE_METADATA'},
    {role:'toolResult',toolCallId:'call',isError:true,content:[{type:'text',text:'PUBLIC_RESULT_START '+ 'y'.repeat(4000)+' PUBLIC_TRAILING_RESULT'}],details:{private:'OMIT_PRIVATE_METADATA'}}];
  const rows=overviewRecords(projection(messages));
  for(const [role,marker] of [['user','PUBLIC_TRAILING_CORRECTION'],['toolResult','PUBLIC_TRAILING_RESULT']]){
    const row=rows.find(row=>row.kind==='message'&&row.role===role);
    assert.ok(JSON.stringify(row).includes(marker));assert.equal(row.payload_source.block_index,0);
    assert.equal(row.payload_source.block_field,'text');assert.ok(row.payload.omitted_char_ranges.length);
    assert.ok(!JSON.stringify(row).includes('OMIT_PRIVATE_METADATA'));
  }
});
test('many user messages leave record slots for recent failed and repaired tool evidence',t=>{
  const messages=Array.from({length:30},(_,index)=>user(`PUBLIC_DIRECTION_${index}`));
  for(const [id,isError] of [['failed',true],['repaired',false]])messages.push(
    {role:'assistant',content:[{type:'toolCall',id,name:'bash',arguments:{command:'public fixture'}}]},
    {role:'toolResult',toolCallId:id,isError,content:[{type:'text',text:id}]} );
  messages.push(text('PUBLIC_FINAL_CONCLUSION'),user('continue'));
  const rows=overviewRecords(projection(messages)),tools=rows.filter(row=>row.kind==='tool_observation');
  assert.deepEqual(tools.map(row=>row.status),['succeeded','failed']);
  assert.ok(tools.every(row=>row.result_source!==null));
  const selectedUsers=rows.filter(row=>row.role==='user').map(row=>row.projection_index);
  assert.ok(selectedUsers.includes(0));assert.ok(selectedUsers.includes(15));assert.ok(selectedUsers.includes(29));assert.ok(selectedUsers.includes(messages.length-1));
  assert.ok(JSON.stringify(rows).includes('PUBLIC_FINAL_CONCLUSION'));assert.ok(rows.length<=20);
  t.diagnostic(`Recovered both failed/repaired statuses and ${selectedUsers.length}/31 user messages; ${JSON.stringify(rows).length} serialized UTF-16 chars including manifest.`);
});

test('interior assistant conclusions survive later correction, tool flood and a trivial final acknowledgment',t=>{
  const messages=[user('PUBLIC_INITIAL_DIRECTION'),text('PUBLIC_INITIAL_RESPONSE'),user('PUBLIC_INTERIOR_DIRECTION'),text('PUBLIC_INTERIOR_CONCLUSION'),user('PUBLIC_LATER_CORRECTION')];
  for(let i=0;i<80;i++)messages.push({role:'assistant',content:[{type:'toolCall',id:`t${i}`,name:'bash',arguments:{command:'public fixture'}}]},
    {role:'toolResult',toolCallId:`t${i}`,isError:i===78,content:[{type:'text',text:'public result'}]});
  messages.push(text('PUBLIC_CORRECTION_RESPONSE'),user('continue'),text('OK'));
  const rows=overviewRecords(projection(messages)),serialized=JSON.stringify(rows);
  for(const marker of ['PUBLIC_INITIAL_DIRECTION','PUBLIC_INTERIOR_DIRECTION','PUBLIC_LATER_CORRECTION','PUBLIC_INTERIOR_CONCLUSION','PUBLIC_CORRECTION_RESPONSE'])assert.ok(serialized.includes(marker),marker);
  assert.deepEqual(rows.filter(row=>row.kind==='tool_observation').slice(0,2).map(row=>row.status),['succeeded','failed']);
  assert.equal(rows[0].assistant_text_coverage.projected,4);assert.equal(rows[0].assistant_text_coverage.selected,4);
  assert.ok(rows.length<=20);assert.ok(JSON.stringify(rows.slice(1)).length<10020);
  t.diagnostic(`Recovered 4/4 text assistants, 4/4 users and recent failed/repaired observations; ${serialized.length} serialized UTF-16 chars including manifest.`);
});
