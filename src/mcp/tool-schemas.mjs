import { z } from 'zod';
import { utf16String } from './schema.mjs';
import { readSchema as publicReadSchema } from '../read/read-schema.mjs';
import { SEND_MODES, promptSchema } from '../ops/prompt-input.mjs';
import { modelsSchema } from '../ops/models.mjs';
import { sessionSettingsSchema } from '../ops/set-model.mjs';
const id = utf16String(128).min(1);
const waitMs = z.number().int().min(0).max(30000).optional();
const sessionTarget = z.strictObject({ session_id: id });
const stopSchema = sessionTarget.extend({
  max_chars: z.number().int().min(256).max(32768).optional(),
});
const bashSchema = stopSchema.extend({
  command: utf16String(100000).min(1),
  exclude_from_context: z.boolean().optional(),
});
const maintainSchema = sessionTarget
  .extend({
    action: z.enum(['compact', 'reload']),
    instructions: utf16String(100000).optional(),
    interrupt: z.boolean().optional(),
  })
  .refine(
    (args) =>
      args.action === 'compact' ||
      (args.instructions === undefined && args.interrupt === undefined),
    { message: 'instructions and interrupt apply only to action "compact"' },
  );
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
export const inputOperations = new Set(['send', 'command', 'maintain_session']);

export const publicOperationSchemas = {
  list_sessions: z
    .strictObject({
      project: utf16String(200).optional(),
      name: utf16String(200).optional(),
      active_after: date.optional(),
      active_before: date.optional(),
      session_id: id.optional(),
      wait_ms: waitMs,
      ...modelsSchema.shape,
    })
    .refine(
      (args) =>
        !args.active_after ||
        !args.active_before ||
        Date.parse(args.active_after) <= Date.parse(args.active_before),
      { message: 'active_after must not exceed active_before' },
    ),
  create_session: promptSchema
    .extend({
      project: directory,
      name: utf16String(200).min(1).optional(),
      fork_from: id.optional(),
      wait_ms: waitMs,
    })
    .strict()
    .refine(
      (args) =>
        hasPrompt(args) ||
        (args.model === undefined &&
          args.thinking_level === undefined &&
          args.wait_ms === undefined),
      { message: 'Model, thinking_level and wait_ms require text or images' },
    ),
  update_session: sessionSettingsSchema.safeExtend({ session_id: id }),
  maintain_session: maintainSchema,
  delete_session: sessionTarget,
  read: publicReadSchema,
  send: promptSchema
    .extend({
      session_id: id,
      mode: z.enum(SEND_MODES).optional(),
      wait_ms: waitMs,
    })
    .strict()
    .refine(hasPrompt, { message: 'Text or images required' }),
  command: bashSchema,
  stop: stopSchema,
  submission: sessionTarget.extend({ submission_id: z.string().uuid() }),
  models: modelsSchema,
  health: sessionTarget.partial(),
};
export const batchOperationSchema = z.strictObject({
  op: z.enum(Object.keys(publicOperationSchemas)),
  args: z.record(z.string(), z.unknown()),
});
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
  ['list_sessions', 'read', 'models', 'submission', 'health'].map((name) => [
    name,
    { readOnlyHint: true, destructiveHint: false },
  ]),
);
