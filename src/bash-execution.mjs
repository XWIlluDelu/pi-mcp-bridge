// Native Pi bash results, not a second shell executor.
import path from 'node:path';
import {Journal} from './journal.mjs';
import { textCursorOffset, textBoundary, textCursor, fitDecodedText } from './data.mjs';
import { hash } from './storage.mjs';
const results=dir=>new Journal({stateDir:path.join(dir,'bash'),principal:'native-bash-results'});
export function nativeBashResult(value){
 if(!value||typeof value.output!=='string'||typeof value.cancelled!=='boolean'||typeof value.truncated!=='boolean'||
    !(value.exitCode==null||Number.isSafeInteger(value.exitCode))||
    !(value.fullOutputPath==null||typeof value.fullOutputPath==='string'))throw new Error('INVALID_BASH_RESULT');
 return {output:value.output,exitCode:value.exitCode??null,cancelled:value.cancelled,truncated:value.truncated,fullOutputPath:value.fullOutputPath??null};
}
export function bashCapture(dir,session,generation,id){
 if(!/^[a-f0-9]{64}$/.test(id??''))throw new Error('INVALID_BASH_REQUEST');
 return value=>results(dir).put(id,{file:session.file,sessionId:session.header.id,generation,...nativeBashResult(value)});
}
export async function recoveredBash(dir,session,generation,id){
 const result=await results(dir).get(id);
 if(!result)return null;
 if(result.file!==session.file||result.sessionId!==session.header.id||result.generation!==generation)throw new Error('RUNTIME_SESSION_CHANGED');
 nativeBashResult(result);return result;
}
export function bashOutputPage(receipt,record,args){
 const binding={session_id:args.session_id,view:'bash_output',entry_id:args.request_id,message_index:0};
 const revision=hash(record),offset=textCursorOffset({...binding,cursor:args.cursor},revision,null);
 if(offset>record.output.length||!textBoundary(record.output,offset))throw new Error('INVALID_CURSOR');
 const rest=record.output.slice(offset),units=fitDecodedText(rest,args.max_chars??12000,output=>({output}));
 if(rest&&!units)throw new Error('BASH_BUDGET_TOO_SMALL');
 const end=offset+units;
 return {...receipt,output_available:true,output:rest.slice(0,units),exitCode:record.exitCode,
  cancelled:record.cancelled,truncated:record.truncated,fullOutputPath:record.fullOutputPath,
  text_offset:offset,total_text_units:record.output.length,offset_units:'utf16_code_units',
  output_complete:end===record.output.length,next_cursor:end<record.output.length?textCursor(binding,revision,null,end):null};
}
