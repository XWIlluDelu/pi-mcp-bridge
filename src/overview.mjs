// Deterministic extractive overview of Pi's public session projection.
// No model calls, hook replay, semantic goal inference or runtime-state guesses.
const MAX_RECORDS=19, MAX_CHARS=10000, EXCERPT_CHARS=1000;
export const OVERVIEW_EXTRACTOR_VERSION='extractive_v3';
function excerpt(value) {
  const json=JSON.stringify(value);
  return json.length<=EXCERPT_CHARS ? {value} : {
    json_excerpt:json.slice(0,EXCERPT_CHARS),total_chars:json.length,
    omitted_char_ranges:[[EXCERPT_CHARS,json.length]],
  };
}
// Breadth-first subdivision covers interior positions before nearby repeats.
// This is positional coverage, not a judgment about semantic importance.
function spreadIndices(length) {
  if(!length)return [];
  const result=[0];if(length>1)result.push(length-1);
  const intervals=[[0,length-1]];
  for(let i=0;i<intervals.length;i++){
    const [a,b]=intervals[i];if(b-a<2)continue;
    const middle=Math.floor((a+b)/2);result.push(middle);
    intervals.push([a,middle],[middle,b]);
  }
  return result;
}
function textExcerpt(text,limit=EXCERPT_CHARS){
  const json=JSON.stringify(text);
  if(json.length<=limit)return {value:text};
  const head=Math.ceil(limit/2),tail=limit-head;
  return {json_excerpt:json.slice(0,head),json_tail_excerpt:json.slice(json.length-tail),
    tail_char_offset:json.length-tail,total_chars:json.length,omitted_char_ranges:[[head,json.length-tail]]};
}
// Reuse short blocks' spare capacity without changing which blocks are sampled.
function textBudgets(texts){
  const sizes=texts.map(text=>JSON.stringify(text).length),budgets=sizes.map(()=>0);
  let remaining=EXCERPT_CHARS,active=sizes.map((_,index)=>index);
  while(remaining&&active.length){
    const share=Math.max(1,Math.floor(remaining/active.length));
    for(const index of active){
      const added=Math.min(share,sizes[index]-budgets[index],remaining);
      budgets[index]+=added;remaining-=added;
    }
    active=active.filter(index=>budgets[index]<sizes[index]);
  }
  return budgets;
}
function omittedBlocks(length,selected){
  const ranges=[];let start=0;
  for(const index of [...selected].sort((a,b)=>a-b)){
    if(index>start)ranges.push([start,index]);start=index+1;
  }
  if(start<length)ranges.push([start,length]);return ranges;
}
const source=r=>({entry_id:r.entry_id,message_index:r.message_index,projection_index:r.projection_index});
function messageDetails(message) {
  const details={},fieldOmissions=[];
  for(const field of ['stopReason','isError','toolCallId','errorMessage']){
    const value=message[field];
    if(typeof value==='boolean')details[field]=value;
    else if(typeof value==='string'){
      const limit=field==='errorMessage'?256:128;details[field]=value.slice(0,limit);
      if(value.length>limit)fieldOmissions.push({field,total_chars:value.length,omitted_char_ranges:[[limit,value.length]]});
    }
  }
  if(fieldOmissions.length)details.field_omissions=fieldOmissions;
  // Select only projected content. Keep the original block index even when
  // thinking precedes text; hidden source-entry bodies are never consulted.
  const textIndex=Array.isArray(message.content)?message.content.findIndex(b=>b.type==='text'&&typeof b.text==='string'):-1;
  if(['user','assistant','toolResult'].includes(message.role)&&Array.isArray(message.content)){
    const selectedIndex=textIndex>=0?textIndex:message.content.findIndex(b=>b.type==='toolCall');
    if(textIndex>=0){
      const textIndices=message.content.flatMap((block,index)=>block.type==='text'&&typeof block.text==='string'?[index]:[]);
      // Three samples bound per-message provenance while covering both ends and
      // an interior block. The text budget is shared, never multiplied.
      const chosen=spreadIndices(textIndices.length).slice(0,3).map(index=>textIndices[index]);
      const budgets=textBudgets(chosen.map(index=>message.content[index].text));
      details.payload=textExcerpt(message.content[textIndex].text,budgets[0]);
      details.payload_source={field:'content',block_index:textIndex,block_field:'text'};
      if(chosen.length>1)details.additional_text_blocks=chosen.slice(1).map((index,offset)=>({
        payload:textExcerpt(message.content[index].text,budgets[offset+1]),
        payload_source:{field:'content',block_index:index,block_field:'text'},
      }));
      details.selected_text_blocks=chosen;
    }else if(selectedIndex>=0){
      // Opaque provider signatures and thinking metadata are not semantic
      // overview content. Do not recursively filter actual tool arguments.
      const {type,id,name,arguments:args}=message.content[selectedIndex];
      details.payload=excerpt({type,id,name,arguments:args});
      details.payload_source={field:'content',block_index:selectedIndex,fields:['type','id','name','arguments']};
    }else{
      details.payload=excerpt({role:message.role});
      details.payload_source={field:'message',fields:['role']};
    }
    const selected=details.selected_text_blocks??(selectedIndex>=0?[selectedIndex]:[]);
    delete details.selected_text_blocks;
    details.omitted_content_block_ranges=omittedBlocks(message.content.length,selected);
    details.omitted_content_block_count=message.content.length-selected.length;
    details.omitted_message_fields=Object.keys(message).filter(k=>!['role','content','stopReason','isError','toolCallId','errorMessage'].includes(k));
  }else if(['user','assistant','toolResult'].includes(message.role)&&typeof message.content==='string'){
    details.payload=textExcerpt(message.content);details.payload_source={field:'content'};
  }else{details.payload=excerpt(message);details.payload_source={field:'message'};}
  return details;
}
export function overviewRecords(projection) {
  const rows=projection.entries.flatMap(e=>e.messages.map((message,message_index)=>({
    entry_id:e.sourceEntry.id,message_index,message,type:e.sourceEntry.type,
  }))).map((r,projection_index)=>({...r,projection_index}));
  const users=rows.filter(r=>r.type==='message'&&r.message.role==='user');
  const assistants=rows.filter(r=>r.message.role==='assistant'&&(
    typeof r.message.content==='string'||Array.isArray(r.message.content)&&r.message.content.some(block=>block.type==='text'&&typeof block.text==='string')));
  const assistantIndices=new Set(assistants.map(row=>row.projection_index));
  const latest=users.at(-1),previous=users.at(-2);
  const checkpoints=rows.filter(r=>r.type==='compaction');
  const checkpoint=checkpoints.at(-1);
  const current=rows.filter(r=>r.projection_index>=(latest?.projection_index??0)&&!['compaction','branch_summary'].includes(r.type));
  // Compaction may retain an assistant/tool suffix while dropping that turn's
  // user. Keep that partial preceding group from the active projection too.
  const prior=latest?rows.filter(r=>r.projection_index>=(previous?.projection_index??0)&&r.projection_index<latest.projection_index&&!['compaction','branch_summary'].includes(r.type)):[];
  const candidates=[],keys=new Set(),toolKeys=new Set(),calls=[],pendingCalls=new Map(),unpairedResults=[];
  // Pair across user boundaries: steering may insert a user message between a
  // call and its result. Only this selected leaf's projected messages count.
  for(const row of rows){
    if(row.message.role==='assistant'&&Array.isArray(row.message.content)){
      for(const call of row.message.content)if(call.type==='toolCall'){
        const item={row,call};calls.push(item);
        const pending=pendingCalls.get(call.id)??[];pending.push(item);pendingCalls.set(call.id,pending);
      }
    }else if(row.message.role==='toolResult'){
      const match=pendingCalls.get(row.message.toolCallId)?.pop();if(match)match.result=row;else unpairedResults.push(row);
    }
  }
  function message(r,label) {
    if(!r||keys.has(r.projection_index))return;
    keys.add(r.projection_index);
    candidates.push({...source(r),kind:'message',label,role:r.message.role,...messageDetails(r.message)});
  }
  function tools(group,label) {
    // Pair each result with the nearest preceding call of the same ID. A
    // missing result is merely unobserved; it does not prove work is running.
    const indices=new Set(group.map(r=>r.projection_index));
    for(const item of calls.toReversed()){
      const {row,call,result}=item;
      if(toolKeys.has(item)||(!indices.has(row.projection_index)&&!indices.has(result?.projection_index)))continue;
      toolKeys.add(item);candidates.push({
      ...source(row),kind:'tool_observation',label,
      status:result?(result.message.isError===true?'failed':result.message.isError===false?'succeeded':'result_observed'):'unobserved',
      result_source:result?source(result):null,payload:excerpt({call_id:call.id,name:call.name,arguments:call.arguments}),
      });
    }
    for(const result of unpairedResults.toReversed()){
      if(toolKeys.has(result)||!indices.has(result.projection_index))continue;
      toolKeys.add(result);candidates.push({...source(result),kind:'tool_observation',label,
        status:result.message.isError===true?'failed':result.message.isError===false?'succeeded':'result_observed',
        call_source:null,result_source:source(result),call_visibility:'not_in_projection',
        payload:excerpt({toolCallId:result.message.toolCallId,toolName:result.message.toolName})});
    }
  }
  message(latest,'latest_user');
  message(rows.findLast(r=>r.message.role==='assistant'),'latest_assistant');
  if(checkpoint)candidates.push({...source(checkpoint),kind:'checkpoint',label:'active_compaction',payload:excerpt(checkpoint.message)});
  if(!checkpoint)message(users[0],'initial_task');
  message(previous,'previous_user');
  message(prior.findLast(r=>assistantIndices.has(r.projection_index)),'previous_assistant');
  const coverageStart=candidates.length;
  for(const index of spreadIndices(users.length))message(users[index],'user_coverage');
  const userCandidates=candidates.splice(coverageStart);
  for(const index of spreadIndices(assistants.length))message(assistants[index],'assistant_coverage');
  const assistantCandidates=candidates.splice(coverageStart);
  tools(current,'current_group');
  tools(prior,'previous_group');
  const toolCandidates=candidates.splice(coverageStart);
  // Interleave positional user and text-assistant coverage with recent tool
  // evidence after fixed anchors; no one stream takes every remaining slot.
  for(let i=0;i<Math.max(userCandidates.length,assistantCandidates.length,toolCandidates.length);i++){
    if(userCandidates[i])candidates.push(userCandidates[i]);
    if(toolCandidates[i])candidates.push(toolCandidates[i]);
    if(assistantCandidates[i])candidates.push(assistantCandidates[i]);
  }
  // A large tool body cannot consume the overview before the current request,
  // latest assistant, paired statuses and active checkpoint are considered.
  for(const row of current.toReversed())message(row,'current_group');
  message(previous,'previous_user');
  message(prior.findLast(r=>r.message.role==='assistant'),'previous_assistant');
  tools(prior,'previous_group');
  for(const row of prior.toReversed())message(row,'previous_group');
  for(const row of rows.filter(r=>r.type==='branch_summary').toReversed()){
    candidates.push({...source(row),kind:'branch_summary',label:'branch_summary',payload:excerpt(row.message)});
  }
  const selected=[];let chars=0;
  for(const record of candidates){
    const size=JSON.stringify(record).length;
    if(selected.length<MAX_RECORDS&&chars+size<=MAX_CHARS){selected.push(record);chars+=size;}
  }
  const covered=new Set(selected.filter(r=>r.kind!=='tool_observation').map(r=>r.projection_index));
  const omitted=[];
  for(let i=0;i<rows.length;i++)if(!covered.has(i)){
    if(omitted.at(-1)?.[1]===i)omitted.at(-1)[1]=i+1;else omitted.push([i,i+1]);
  }
  return [{kind:'overview_manifest',selection:OVERVIEW_EXTRACTOR_VERSION,checkpoint:checkpoint?source(checkpoint):null,
    latest_user:latest?source(latest):null,initial_task:!checkpoint&&users[0]?source(users[0]):null,
    projection_messages:rows.length,omitted_projection_ranges:omitted,
    user_coverage:{projected:users.length,selected:selected.filter(r=>r.kind==='message'&&r.role==='user').length,
      policy:'anchors_then_interleave_breadth_first_users_recent_tools_and_text_assistants'},
    assistant_text_coverage:{projected:assistants.length,selected:selected.filter(r=>r.kind==='message'&&assistantIndices.has(r.projection_index)).length},
    text_sampling:'first_last_middle_blocks_with_head_tail_excerpts',
    omitted_candidate_records:candidates.length-selected.length,
    range_units:'half_open_utf16_for_chars_and_zero_based_projection_and_content_block_indices',
    selection_limits:{records:MAX_RECORDS,serialized_chars:MAX_CHARS,excerpt_chars:EXCERPT_CHARS}},...selected];
}
