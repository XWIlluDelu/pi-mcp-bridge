const boolean=value=>typeof value==='boolean'?value:null;
export function activityObservation(source='none',values={}) {
  return {scope:'current_runtime',source,observed_at:source==='none'?null:new Date().toISOString(),
    idle:boolean(values.idle),streaming:boolean(values.streaming),compacting:boolean(values.compacting),
    pending_messages:boolean(values.pending),
    pending_message_count:Number.isSafeInteger(values.count)&&values.count>=0?values.count:null,
    preparing:null,
    bridge_admission:values.admission===undefined?null:{source:'bridge_rpc_ack_fence',pending:boolean(values.admission)},
    limitations:['preparing_unobservable','idle_not_task_completion']};
}
export function rpcActivity(state,admission) {
  const count=Number.isSafeInteger(state.pendingMessageCount)&&state.pendingMessageCount>=0?state.pendingMessageCount:null;
  return activityObservation('rpc_get_state',{
    streaming:state.isStreaming,compacting:state.isCompacting,
    // get_state does not expose isIdle; streaming/compacting alone do not cover
    // every busy phase of Pi. Leave idle unknown rather than infer it.
    count,pending:count===null?null:count>0,admission,
  });
}
