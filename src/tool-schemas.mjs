import { z } from 'zod';
import { readSchema as publicReadSchema } from './read-schema.mjs';
import { compactSchema } from './compact.mjs';
import { SEND_MODES, imagesSchema } from './prompt-input.mjs';
import { modelSelectionSchema, thinkingLevelSchema, modelsSchema } from './models.mjs';
import { modelSettingsSchema } from './set-model.mjs';
const id = z.string().min(1).max(128);
const executionShape = {
  session_id: id,
  timeout_ms: z.number().int().min(50).max(30000).optional(),
  max_chars: z.number().int().min(256).max(32768).optional(),
};
export const stopSchema = z.object(executionShape).strict();
export const bashSchema = z
  .object({
    ...executionShape,
    command: z.string().min(1).max(100000),
  })
  .strict();
const hasPrompt = (args) => args.text !== undefined || args.images !== undefined;
// Public contracts also validate direct Bridge calls.
const timeout = z.number().int().min(50).max(30000).optional();
const directory = z.string().min(1).max(4096);
const date = z.string().datetime({ offset: true });
export const publicOperationSchemas = {
  models: modelsSchema,
  set_model: z
    .object({ session_id: id, ...modelSettingsSchema.innerType().shape })
    .strict()
    .refine((args) => args.model !== undefined || args.thinking_level !== undefined, {
      message: 'Model or thinking level required',
    }),
  compact: compactSchema,
  read: publicReadSchema,
  send: z
    .object({
      session_id: id,
      text: z.string().min(1).max(100000).optional(),
      images: imagesSchema.optional(),
      model: modelSelectionSchema.optional(),
      thinking_level: thinkingLevelSchema.optional(),
      mode: z.enum(SEND_MODES).optional(),
      timeout_ms: timeout,
    })
    .strict()
    .refine(hasPrompt, { message: 'Text or images required' }),
  command: bashSchema,
  stop: stopSchema,
  create: z
    .object({
      project: directory,
      text: z.string().min(1).max(100000).optional(),
      images: imagesSchema.optional(),
      model: modelSelectionSchema.optional(),
      thinking_level: thinkingLevelSchema.optional(),
      name: z.string().min(1).max(200).optional(),
      fork_from: id.optional(),
      timeout_ms: timeout,
    })
    .strict()
    .refine(hasPrompt, { message: 'Text or images required' }),
  delete: z.object({ session_id: id }).strict(),
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
  health: z.object({ session_id: id.optional() }).strict(),
};
publicOperationSchemas.list = publicSchemas.list;
publicOperationSchemas.health = publicSchemas.health;
