import { z } from 'zod';
const id=z.string().min(1).max(128);
const request=z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const operationSchemas={
 read:z.object({session_id:id,view:z.enum(['context','raw','summary','overview','status']).optional(),entry_id:id.optional(),leaf_id:z.string().nullable().optional(),since:id.optional(),query:z.string().max(200).optional(),cursor:z.string().max(2048).optional(),limit:z.number().int().min(1).max(50).optional(),max_chars:z.number().int().min(256).max(32768).optional(),after_settlement:z.object({generation:id,sequence:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)}).strict().optional(),wait_ms:z.number().int().min(0).max(10000).optional()}),
 send:z.object({session_id:id,request_id:request,text:z.string().min(1).max(100000).optional(),mode:z.enum(['native','idle_only','steer','queue']).optional(),timeout_ms:z.number().int().min(50).max(30000).optional()}),
 create:z.object({folder_id:id,request_id:request}),
 delete:z.object({session_id:id,request_id:request}),
};
const validRead=args=>args.view==='status'
 ? ['entry_id','leaf_id','since','query','cursor','limit','max_chars'].every(key=>args[key]===undefined)&&(!(args.wait_ms>0)||args.after_settlement!==undefined)
 : args.wait_ms===undefined&&args.after_settlement===undefined;
export const readSchema=operationSchemas.read.refine(validRead,{message:'Status accepts only a settlement baseline and bounded wait; waiting requires a baseline'});
export const batchSchema=z.object({operations:z.array(z.discriminatedUnion('op',Object.entries(operationSchemas).map(([op,args])=>z.object({op:z.literal(op),args:op==='read'?args.strict().refine(validRead):args.strict()}).strict()))).min(1).max(10)}).strict();
