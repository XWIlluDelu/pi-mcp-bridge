import { z } from 'zod';
import { utf16String } from './schema.mjs';
import { readSchema as publicReadSchema, searchSchema } from '../read/read-schema.mjs';
import { compactSchema } from '../ops/compact.mjs';
import { SEND_MODES, promptSchema } from '../ops/prompt-input.mjs';
import { modelsSchema } from '../ops/models.mjs';
import { modelSettingsSchema } from '../ops/set-model.mjs';
const id = utf16String(128).min(1);
const executionShape = {
  session_id: id,
  max_chars: z.number().int().min(256).max(32768).optional(),
};
const stopSchema = z.object(executionShape).strict();
const bashSchema = z
  .object({
    ...executionShape,
    command: utf16String(100000).min(1),
  })
  .strict();
// Owners receive the same command/stop arguments, already bound to their session.
export const ownerControlSchemas = {
  bash: bashSchema.omit({ session_id: true }),
  stop: stopSchema.omit({ session_id: true }),
};
const hasPrompt = (args) => args.text !== undefined || args.images !== undefined;
// The MCP tool boundary and batch planning validate against these schemas once;
// Bridge operation methods receive parsed arguments.
const directory = utf16String(4096).min(1);
const date = z.string().datetime({ offset: true });
export const inputOperations = new Set(['send', 'command', 'compact', 'reload']);

export const publicOperationSchemas = {
  list: z
    .object({
      project: utf16String(200).optional(),
      name: utf16String(200).optional(),
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
  models: modelsSchema,
  submission: z.object({ session_id: id, submission_id: z.string().uuid() }).strict(),
  set_model: modelSettingsSchema.safeExtend({ session_id: id }),
  compact: compactSchema,
  reload: z.object({ session_id: id }).strict(),
  read: publicReadSchema,
  search: searchSchema,
  send: promptSchema
    .extend({
      session_id: id,
      mode: z.enum(SEND_MODES).optional(),
    })
    .strict()
    .refine(hasPrompt, { message: 'Text or images required' }),
  command: bashSchema,
  stop: stopSchema,
  create: promptSchema
    .extend({
      project: directory,
      name: utf16String(200).min(1).optional(),
      fork_from: id.optional(),
    })
    .strict()
    .refine(
      (args) => hasPrompt(args) || (args.model === undefined && args.thinking_level === undefined),
      { message: 'Model and thinking settings require text or images' },
    ),
  delete: z.object({ session_id: id }).strict(),
  health: z.object({ session_id: id.optional() }).strict(),
};
export const batchOperationSchema = z
  .object({
    op: z.enum(Object.keys(publicOperationSchemas)),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
// Advertise the operation shape while admitting malformed items for item-level errors.
const { $schema, ...batchOperationShape } = z.toJSONSchema(batchOperationSchema, {
  target: 'draft-7',
  io: 'input',
});
const batchSchema = z.strictObject({
  operations: z.array(z.unknown().meta(batchOperationShape)).min(1).max(10),
});
export const publicSchemas = { ...publicOperationSchemas, batch: batchSchema };

export const publicAnnotations = Object.fromEntries(
  ['list', 'read', 'search', 'models', 'submission', 'health'].map((name) => [
    name,
    { readOnlyHint: true, destructiveHint: false },
  ]),
);
