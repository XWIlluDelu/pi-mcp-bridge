import { batchSchema } from './tool-schemas.mjs';
import { diagnostics, diagnosticRef } from './diagnostics.mjs';
import { rebudgetRead } from './read-page.mjs';
export const BATCH_RESPONSE_LIMIT=32768;
// Ten 100,000-code-unit prompts, worst-case JSON escaping, plus envelopes.
export const BATCH_INPUT_LIMIT=6100000;
const fail=(code,items=[],extra={})=>({status:'rejected',error:{code,items,...extra},results:[]});
const publicError=error=>/^[A-Z][A-Z_]{2,60}$/.test(error.message)?error.message:'OPERATION_FAILED';
export function preflightBatch(input){
 const parsed=batchSchema.safeParse(input);
 if(!parsed.success)return {error:fail('INVALID_BATCH',[...new Set(parsed.error.issues.map(x=>x.path[1]).filter(Number.isInteger))])};
 const operations=parsed.data.operations;
 if(JSON.stringify(parsed.data).length>BATCH_INPUT_LIMIT)return {error:fail('BATCH_INPUT_TOO_LARGE')};
 const sessions=new Map(),requests=new Map();
 for(const [index,item]of operations.entries()){
  const {op,args}=item;
  if(args.session_id){const entries=sessions.get(args.session_id)??[];entries.push({index,op});sessions.set(args.session_id,entries);}
  if(op==='read')continue;
  const key=`${op}:${args.session_id??args.folder_id}`;
  const body=op==='send'?(args.text===undefined?undefined:JSON.stringify({text:args.text,mode:args.mode??'native'})):'{}';
  const previous=requests.get(args.request_id);
  if(previous&&(previous.key!==key||(previous.body!==undefined&&body!==undefined&&previous.body!==body)))return {error:fail('REQUEST_ID_CONFLICT',[previous.index,index])};
  if(!previous||previous.body===undefined)requests.set(args.request_id,{index,key,body});
 }
 for(const [session_id,entries]of sessions){
  if(entries.some(x=>x.op==='delete')&&entries.some(x=>x.op!=='delete'))return {error:fail('DELETE_CONFLICT',entries.map(x=>x.index),{session_id})};
 }
 return {operations};
}
export async function executeBatch(bridge,input){
 const {operations,error}=preflightBatch(input);if(error)return error;
 const payload={status:'processed',response_max_chars:BATCH_RESPONSE_LIMIT,results:[]};
 const captures=[];
 for(const [index,{op,args}]of operations.entries()){
  const item={index,op};
  const actual=op==='read'?{...args,max_chars:args.max_chars??12000}:args;
  // Upper bound on returned item content, not an exact measurement or the
  // original I/O budget: later snapshot resizing may lower this bound.
  if(op==='read')item.applied_max_chars=actual.max_chars;
  try{item.result=await diagnostics.measure('batch.item',{op,index,mutation_ref:diagnosticRef(args.request_id),session_ref:diagnosticRef(args.session_id)},()=>bridge[op](actual));}catch(e){item.error={code:publicError(e)};}
  payload.results.push(item);
  if(op==='read'&&item.result!==undefined){item.result=structuredClone(item.result);captures.push({item,args:actual,result:item.result});}
 }
 const size=value=>JSON.stringify(value).length;
 if(size(payload)>BATCH_RESPONSE_LIMIT&&captures.length){
  // Water-fill using actual serialized envelopes. Small reads release their
  // unused share to large reads regardless of operation order.
  const sizes=captures.map(c=>size(c.result));
  const available=Math.max(0,BATCH_RESPONSE_LIMIT-(size(payload)-sizes.reduce((a,b)=>a+b,0)));
  let low=0,high=Math.max(...sizes);
  while(low<high){const mid=Math.ceil((low+high)/2);if(sizes.reduce((sum,n)=>sum+Math.min(n,mid),0)<=available)low=mid;else high=mid-1;}
  for(const capture of captures){
   const budget=Math.min(size(capture.result),low);
   const resized=rebudgetRead(capture.result,capture.args,budget);
   if(resized){capture.item.result=resized;capture.item.applied_max_chars=Math.min(capture.args.max_chars,budget);}
   else {delete capture.item.result;capture.item.error={code:'BATCH_RESULT_OMITTED',retry:'READ_SEPARATELY'};}
  }
  // Complete-record pagination can leave spare capacity. Try larger prefixes
  // from the same snapshots; never rerun a read past a later mutation.
  for(const capture of captures){
   const spare=BATCH_RESPONSE_LIMIT-size(payload);if(spare<=0)break;
   const old=capture.item.result,oldSize=old===undefined?0:size(old);
   const resized=rebudgetRead(capture.result,capture.args,oldSize+spare);
   if(resized&&size(resized)>oldSize){
    const previous={...capture.item};capture.item.result=resized;delete capture.item.error;
    capture.item.applied_max_chars=Math.min(capture.args.max_chars,oldSize+spare);
    if(size(payload)>BATCH_RESPONSE_LIMIT){for(const key of Object.keys(capture.item))delete capture.item[key];Object.assign(capture.item,previous);}
   }
  }
 }
 // Preserve normal mutation receipts; oversized exceptional results retain
 // explicit replay guidance instead of silent truncation or fabricated cursors.
 while(JSON.stringify(payload).length>BATCH_RESPONSE_LIMIT){
  const candidates=payload.results.filter(x=>x.result!==undefined);
  const reads=candidates.filter(x=>x.op==='read');
  const largest=(reads.length?reads:candidates).sort((a,b)=>size(b.result)-size(a.result))[0];
  if(!largest)throw new Error('BATCH_RESPONSE_LIMIT');
  delete largest.result;
  largest.error={code:'BATCH_RESULT_OMITTED',retry:largest.op==='read'?'READ_SEPARATELY':'SAME_REQUEST_ID'};
 }
 return payload;
}
