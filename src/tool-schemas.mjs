import { z } from 'zod';
import { readSchema as publicReadSchema } from './read-schema.mjs';
import { SEND_MODES, imagesSchema } from './prompt-input.mjs';
const id = z.string().min(1).max(128);
const request = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/);
export const stopSchema = z
  .object({
    session_id: id,
    request_id: request,
    timeout_ms: z.number().int().min(50).max(30000).optional(),
    max_chars: z.number().int().min(256).max(32768).optional(),
    cursor: z.string().max(2000).optional(),
  })
  .strict();
export const bashSchema = stopSchema.extend({ command: z.string().min(1).max(100000).optional() });
// Public transport contracts. Recovery calls may omit mutation payloads; the
// journal, not schema validation, decides whether an initial payload is required.
const timeout = z.number().int().min(50).max(30000).optional();
const directory = z.string().min(1).max(4096);
const date = z.string().datetime({ offset: true });
export const publicOperationSchemas = {
  read: publicReadSchema,
  send: z
    .object({
      session_id: id,
      request_id: request,
      text: z.string().min(1).max(100000).optional(),
      images: imagesSchema.optional(),
      mode: z.enum(SEND_MODES).optional(),
      timeout_ms: timeout,
    })
    .strict(),
  command: bashSchema,
  stop: stopSchema,
  create: z
    .object({
      project: directory,
      request_id: request,
      text: z.string().min(1).max(100000).optional(),
      images: imagesSchema.optional(),
      name: z.string().min(1).max(200).optional(),
      fork_from: id.optional(),
      timeout_ms: timeout,
    })
    .strict(),
  delete: z.object({ session_id: id, request_id: request }).strict(),
};
export const batchSchema = z.object({ operations: z.array(z.unknown()).min(1).max(10) }).strict();
export const publicSchemas = {
  list: z
    .object({
      project: z.string().max(200).optional(),
      name: z.string().max(200).optional(),
      active_after: date.optional(),
      active_before: date.optional(),
      session_id: id.optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict()
    .refine(
      (args) =>
        !args.active_after ||
        !args.active_before ||
        Date.parse(args.active_after) <= Date.parse(args.active_before),
      { message: 'active_after must not exceed active_before' },
    ),
  ...publicOperationSchemas,
  batch: batchSchema,
  health: z
    .object({ domain: z.literal('permissions').optional(), session_id: id.optional() })
    .strict(),
};
publicOperationSchemas.list = publicSchemas.list;
publicOperationSchemas.health = publicSchemas.health;
