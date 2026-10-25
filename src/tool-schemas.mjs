import { z } from 'zod';
import { readSchema as publicReadSchema, searchSchema } from './read-schema.mjs';
import { compactSchema } from './compact.mjs';
import { SEND_MODES, imagesSchema } from './prompt-input.mjs';
import { modelSelectionSchema, thinkingLevelSchema, modelsSchema } from './models.mjs';
import { modelSettingsSchema } from './set-model.mjs';
const id = z.string().min(1).max(128);
const executionShape = {
  session_id: id,
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
const directory = z.string().min(1).max(4096);
const date = z.string().datetime({ offset: true });
export const publicOperationSchemas = {
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
  models: modelsSchema,
  submission: z.object({ session_id: id, submission_id: z.string().uuid() }).strict(),
  set_model: z
    .object({ session_id: id, ...modelSettingsSchema.innerType().shape })
    .strict()
    .refine((args) => args.model !== undefined || args.thinking_level !== undefined, {
      message: 'Model or thinking level required',
    }),
  compact: compactSchema,
  reload: z.object({ session_id: id }).strict(),
  read: publicReadSchema,
  search: searchSchema,
  send: z
    .object({
      session_id: id,
      text: z.string().min(1).max(100000).optional(),
      images: imagesSchema.optional(),
      model: modelSelectionSchema.optional(),
      thinking_level: thinkingLevelSchema.optional(),
      mode: z.enum(SEND_MODES).optional(),
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
    args: z.record(z.unknown()),
  })
  .strict();
export const batchSchema = z
  .object({
    // Describe valid items, but retain malformed ones for per-item errors rather
    // than rejecting valid siblings at the outer MCP validation boundary.
    operations: z
      .array(batchOperationSchema.catch(({ input }) => input))
      .min(1)
      .max(10),
  })
  .strict();
export const publicSchemas = { ...publicOperationSchemas, batch: batchSchema };

const readableResult = z
  .object({
    session_id: z.string(),
    view: z.enum(['session', 'runtime', 'adapted']),
    presentation: z.enum(['preview', 'source']).optional(),
    reader: z
      .object({
        id: z.string(),
        coverage: z
          .array(
            z.object({
              type: z.string(),
              selected: z.number().int().nonnegative(),
              total: z.number().int().nonnegative(),
              excluded: z.number().int().nonnegative().optional(),
            }),
          )
          .optional(),
      })
      .optional(),
    query: z.string().optional(),
    matches: z.number().int().nonnegative().optional(),
    items: z.array(
      z
        .object({
          type: z.string(),
          ref: z.string().optional(),
          title: z.string().optional(),
          text: z.string().optional(),
          truncated: z.boolean().optional(),
          source: z.record(z.unknown()).optional(),
          branch_relation: z.enum(['on_branch', 'off_branch', 'unknown']).optional(),
          related: z.array(z.object({ relation: z.string(), ref: z.string() })).optional(),
        })
        .passthrough(),
    ),
    next_cursor: z.string().nullable(),
  })
  .passthrough();
// MCP clients also validate structured error results against the advertised
// schema. Success fields remain discoverable alongside the shared error shape.
const readableEnvelope = readableResult.partial().extend({
  error: z.object({ code: z.string() }).passthrough().optional(),
});
export const publicOutputSchemas = {
  read: readableEnvelope,
  search: readableEnvelope,
  submission: z.object({
    session_id: z.string().optional(),
    submission_id: z.string().optional(),
    operation: z.enum(['send', 'create']).optional(),
    receipt: z
      .object({
        status: z.enum([
          'pending',
          'started',
          'queued',
          'handled',
          'dispatched',
          'skipped',
          'rejected',
          'unknown',
        ]),
        reason: z.string().optional(),
        admission: z.literal('unobservable').optional(),
      })
      .optional(),
    submitted_at: z.string().optional(),
    updated_at: z.string().optional(),
    expires_at: z.string().optional(),
    error: z.object({ code: z.string() }).passthrough().optional(),
  }),
};
export const publicAnnotations = Object.fromEntries(
  ['read', 'search', 'submission'].map((name) => [
    name,
    { readOnlyHint: true, destructiveHint: false },
  ]),
);
