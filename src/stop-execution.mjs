// Native cancellation and recoverable withdrawal, never process teardown.
import { Journal } from './journal.mjs';
import path from 'node:path';
import { hash, textCursorOffset, textBoundary, textCursor, fitDecodedText } from './data.mjs';

const withdrawals=dir=>new Journal({stateDir:path.join(dir,'stop'),principal:'withdrawn-inputs'});
export function withdrawalCapture(dir,session,generation,id) {
  if(!/^[a-f0-9]{64}$/.test(id??''))throw new Error('INVALID_STOP_REQUEST');
  const record={file:session.file,sessionId:session.header.id,generation,text:'',includesEditorDraft:false};
  let saving=Promise.resolve();
  return value=>{
    let text,includesEditorDraft=false;
    if(typeof value?.text==='string'){
      text=value.text;includesEditorDraft=value.includesEditorDraft===true;
    }else{
      if(!value||!Array.isArray(value.steering)||!Array.isArray(value.followUp)||
         [...value.steering,...value.followUp].some(text=>typeof text!=='string'))throw new Error('INVALID_STOP_RECEIPT');
      // Exactly the native Escape editor's grouping/order; no inferred chronology.
      text=[...value.steering,...value.followUp].join('\n\n');
    }
    const next=saving.then(async()=>{
      if(text)record.text+=(record.text?'\n\n':'')+text;
      record.includesEditorDraft||=includesEditorDraft;
      await withdrawals(dir).put(id,record);
    });
    saving=next;return next;
  };
}
export async function recoveredWithdrawal(dir,session,generation,id) {
  const record=await withdrawals(dir).get(id);
  if(!record)return null;
  if(record.file!==session.file||record.sessionId!==session.header.id||record.generation!==generation||typeof record.text!=='string')
    throw new Error('RUNTIME_SESSION_CHANGED');
  return record;
}
export function withdrawalPage(receipt,record,args) {
  const binding={session_id:args.session_id,view:'stop_withdrawn',entry_id:args.request_id,message_index:0};
  const revision=hash({generation:record.generation,text:record.text,includesEditorDraft:record.includesEditorDraft});
  const offset=textCursorOffset({...binding,cursor:args.cursor},revision,null);
  if(offset>record.text.length||!textBoundary(record.text,offset))throw new Error('INVALID_CURSOR');
  const rest=record.text.slice(offset),units=fitDecodedText(rest,args.max_chars??12000,text=>({withdrawn_text:text}));
  if(rest&&!units)throw new Error('WITHDRAWAL_BUDGET_TOO_SMALL');
  const end=offset+units;
  return {...receipt,withdrawn_available:true,withdrawn_text:rest.slice(0,units),
    includes_editor_draft:record.includesEditorDraft,text_offset:offset,total_text_units:record.text.length,
    offset_units:'utf16_code_units',withdrawn_complete:end===record.text.length,
    next_cursor:end<record.text.length?textCursor(binding,revision,null,end):null};
}
export function stopReceipt(value) {
  if (!value || (value.status !== undefined && value.status !== 'accepted') ||
      !['native_ack','requested'].includes(value.acknowledgement) || value.coverage!=='agent_and_bash')
    throw new Error('INVALID_STOP_RECEIPT');
  return {status:'accepted',acknowledgement:value.acknowledgement,coverage:'agent_and_bash',
    queue_policy:'withdraw',completion:'not_tracked'};
}
export async function requestRpcStop(client,onWithdraw) {
  if(!['clearQueue','abort','abortBash'].every(name=>typeof client[name]==='function'))throw new Error('STOP_UNSUPPORTED');
  // Submit in order without an ACK round trip between withdrawal/cancellation.
  const cleared=client.clearQueue();
  const cancellation=Promise.allSettled([client.abort(),client.abortBash()]);
  await onWithdraw(await cleared); // Preserve text even if cancellation times out.
  const results=await cancellation,failed=results.find(result=>result.status==='rejected');
  if(failed)throw failed.reason;
  await onWithdraw(await client.clearQueue()); // Inputs admitted during settling.
  return stopReceipt({acknowledgement:'native_ack',coverage:'agent_and_bash'});
}
