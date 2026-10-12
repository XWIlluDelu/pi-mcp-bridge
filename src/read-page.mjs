import { cursorSignature, textCursor, fitDecodedText } from './data.mjs';

// Resize only an already-authorized, captured page. No history is reread after
// later batch operations, and its activity/revision/selection remain unchanged.
export function rebudgetRead(result,args,maxChars){
  const size=value=>JSON.stringify(value).length;
  if(size(result)<=maxChars)return result;
  if(!Array.isArray(result.items))return null;
  if(result.format==='projected_text'){
    const item=result.items[0];
    const build=text=>{
      const end=item.text_offset+text.length;
      return {...result,items:[{...item,text}],
        next_cursor:end<item.total_text_units?textCursor(args,result.revision,result.leaf_id,end):null};
    };
    const length=fitDecodedText(item.text,maxChars,build);
    if(item.text.length&&!length)return null;
    const reduced=build(item.text.slice(0,length));
    return size(reduced)<=maxChars?reduced:null;
  }
  const start=args.cursor?JSON.parse(Buffer.from(args.cursor,'base64url').toString()):{index:0,offset:0};
  let index=start.index,offset=start.offset;
  const signature=cursorSignature({...args,view:args.view??'context'}),items=[];
  const page=(rows,i,o)=>({...result,items:rows,next_cursor:Buffer.from(JSON.stringify({signature,revision:result.revision,index:i,offset:o})).toString('base64url')});
  for(const item of result.items){
    const fragment=typeof item.json_fragment==='string';
    const encoded=fragment?item.json_fragment:JSON.stringify(item);
    const begin=fragment?item.char_offset:0,total=fragment?item.total_chars:encoded.length;
    const end=begin+encoded.length,nextIndex=end>=total?index+1:index,nextOffset=end>=total?0:end;
    const whole=page([...items,item],nextIndex,nextOffset);
    if(size(whole)<=maxChars){items.push(item);index=nextIndex;offset=nextOffset;continue;}
    // Prefer readable complete records over spending the final spare bytes on
    // a fragment of the following record. A first huge record still progresses.
    if(items.length)return page(items,index,offset);
    let low=0,high=encoded.length;
    const partial=amount=>page([{entry_id:item.entry_id,json_fragment:encoded.slice(0,amount),char_offset:begin,total_chars:total}],index,begin+amount);
    while(low<high){const mid=Math.ceil((low+high)/2);if(size(partial(mid))<=maxChars)low=mid;else high=mid-1;}
    return low?partial(low):null;
  }
  // Keeping all captured records retains the source's continuation; no new
  // cursor may promise records outside the captured snapshot.
  return size({...result,items})<=maxChars?{...result,items}:null;
}
