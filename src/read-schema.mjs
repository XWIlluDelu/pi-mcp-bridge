import { z } from 'zod';

const count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
export const contextSelectSchema = z
  .object({
    summary: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    recent_prompts: count.optional(),
    earliest_prompts: count.optional(),
    text: count.optional(),
    thinking: count.optional(),
    tools: count
      .describe('Logical tool units per prompt; 0 also omits system tool declarations.')
      .optional(),
    commands: count.optional(),
  })
  .strict();

export const readSchema = z
  .object({
    session_id: z.string().min(1).max(256).optional(),
    view: z.enum(['native', 'observed']).optional(),
    preset: z.enum(['latest', 'recent', 'full']).optional(),
    select: contextSelectSchema.optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    cursor: z.string().min(1).max(4096).optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
  })
  .strict()
  .refine((args) => args.session_id !== undefined || args.cursor !== undefined, {
    message: 'Session ID or cursor required',
  })
  .refine(
    (args) =>
      args.view !== 'observed' ||
      [args.preset, args.select, args.leaf_id].every((value) => value === undefined),
    { message: 'Observed reads do not accept native selection or leaf overrides' },
  );

export const FULL_SELECTION = Object.freeze({
  summary: -1,
  recent_prompts: -1,
  earliest_prompts: -1,
  text: -1,
  thinking: -1,
  tools: -1,
  commands: -1,
});
export const RECENT_SELECTION = Object.freeze({
  summary: 1,
  recent_prompts: 3,
  earliest_prompts: 0,
  text: -1,
  thinking: 3,
  tools: 0,
  commands: 0,
});
export const LATEST_SELECTION = Object.freeze({
  summary: 0,
  recent_prompts: 1,
  earliest_prompts: 0,
  text: -1,
  thinking: 2,
  tools: 0,
  commands: 0,
});
export function contextSelection(args) {
  return {
    ...(args.preset === 'full'
      ? FULL_SELECTION
      : args.preset === 'recent'
        ? RECENT_SELECTION
        : LATEST_SELECTION),
    ...Object.fromEntries(
      Object.entries(args.select ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
}
