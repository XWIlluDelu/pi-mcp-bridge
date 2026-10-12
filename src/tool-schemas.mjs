import { z } from 'zod';
const id=z.string().min(1).max(128);
const request=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
const index=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const hasTextSelector=args=>['message_index','block_index','text_offset','field','section'].some(key=>args[key]!==undefined);
export const operationSchemas={
 read:z.object({session_id:id,view:z.enum(['context','raw','summary','overview','status']).optional(),entry_id:id.optional(),field:z.enum(['content','sections']).describe('Projected message field; defaults to content. sections requires a named system-message section.').optional(),section:id.describe('Exact own key in projected SystemMessage.sections; string values only. No merge or metadata flattening.').optional(),message_index:index.describe('Zero-based projected message within entry_id; context only. Selects content text or a named system section, not raw source.').optional(),block_index:index.describe('Zero-based block in effective projected content; only type:text is supported. Required for array content.').optional(),text_offset:index.describe('Initial decoded-text offset in UTF-16 code units (not JSON excerpt offsets); cannot split a surrogate pair.').optional(),leaf_id:z.string().nullable().optional(),since:id.optional(),query:z.string().max(200).optional(),cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(50).optional(),max_chars:z.number().int().min(256).max(32768).optional(),after_settlement:z.object({generation:id,sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict().optional(),wait_ms:z.number().int().min(0).max(10000).optional()}),
 send:z.object({session_id:id,request_id:request,text:z.string().min(1).max(100000).optional(),mode:z.enum(['native','idle_only','steer','queue']).optional(),timeout_ms:z.number().int().min(50).max(30000).optional()}),
 create:z.object({folder_id:id,request_id:request}),
 delete:z.object({session_id:id,request_id:request}),
};
const validRead=args=>args.view==='status'
 ? ['entry_id','field','section','message_index','block_index','text_offset','leaf_id','since','query','cursor','limit','max_chars'].every(key=>args[key]===undefined)&&(!(args.wait_ms>0)||args.after_settlement!==undefined)
 : args.wait_ms===undefined&&args.after_settlement===undefined&&(!hasTextSelector(args)||
   ((args.view===undefined||args.view==='context')&&args.entry_id!==undefined&&args.message_index!==undefined&&
    ['since','query'].every(key=>args[key]===undefined)&&
    (args.field==='sections'?args.section!==undefined&&args.block_index===undefined:args.section===undefined)));
export const readSchema=operationSchemas.read.refine(validRead,{message:'Invalid read view, text selector or status wait combination'});
export const batchSchema=z.object({operations:z.array(z.discriminatedUnion('op',Object.entries(operationSchemas).map(([op,args])=>z.object({op:z.literal(op),args:op==='read'?args.strict().refine(validRead):args.strict()}).strict()))).min(1).max(10)}).strict();
