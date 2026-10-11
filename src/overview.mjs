// Deterministic extractive overview of Pi's public session projection.
// No model calls, hook replay, semantic goal inference or runtime-state guesses.
const MAX_RECORDS=19, MAX_CHARS=10000, EXCERPT_CHARS=1000;
function excerpt(value) {
  const json=JSON.stringify(value);
  return json.length<=EXCERPT_CHARS ? {value} : {
    json_excerpt:json.slice(0,EXCERPT_CHARS),total_chars:json.length,
    omitted_char_ranges:[[EXCERPT_CHARS,json.length]],
  };
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
  const textIndex=message.role==='assistant'&&Array.isArray(message.content)?message.content.findIndex(b=>b.type==='text'&&typeof b.text==='string'):-1;
  if(message.role==='assistant'&&Array.isArray(message.content)){
    const selectedIndex=textIndex>=0?textIndex:message.content.findIndex(b=>b.type==='toolCall');
    if(textIndex>=0){
      details.payload=excerpt(message.content[textIndex].text);
      details.payload_source={field:'content',block_index:textIndex,block_field:'text'};
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
    details.omitted_content_block_ranges=[];
    if(selectedIndex>0)details.omitted_content_block_ranges.push([0,selectedIndex]);
    if(selectedIndex+1<message.content.length)details.omitted_content_block_ranges.push([selectedIndex+1,message.content.length]);
    details.omitted_content_block_count=message.content.length-(selectedIndex>=0?1:0);
    details.omitted_message_fields=Object.keys(message).filter(k=>!['role','content','stopReason','isError','toolCallId','errorMessage'].includes(k));
  }else{details.payload=excerpt(message);details.payload_source={field:'message'};}
  return details;
}
export function overviewRecords(projection) {
  const rows=projection.entries.flatMap(e=>e.messages.map((message,message_index)=>({
    entry_id:e.sourceEntry.id,message_index,message,type:e.sourceEntry.type,
  }))).map((r,projection_index)=>({...r,projection_index}));
  const users=rows.filter(r=>r.type==='message'&&r.message.role==='user');
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
  tools(current,'current_group');
  if(!checkpoint)message(users[0],'initial_task');
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
  return [{kind:'overview_manifest',selection:'extractive_v1',checkpoint:checkpoint?source(checkpoint):null,
    latest_user:latest?source(latest):null,initial_task:!checkpoint&&users[0]?source(users[0]):null,
    projection_messages:rows.length,omitted_projection_ranges:omitted,
    omitted_candidate_records:candidates.length-selected.length,
    range_units:'half_open_utf16_for_chars_and_zero_based_projection_and_content_block_indices',
    selection_limits:{records:MAX_RECORDS,serialized_chars:MAX_CHARS,excerpt_chars:EXCERPT_CHARS}},...selected];
}
