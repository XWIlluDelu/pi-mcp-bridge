import { z } from 'zod';

const count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
export const contextSelectSchema = z
  .object({
    summary: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
    recent_prompts: count.optional(),
    earliest_prompts: count.optional(),
    text: count.optional(),
    thinking: count.optional(),
    tools: count.optional(),
    commands: count.optional(),
  })
  .strict();

export const readSchema = z
  .object({
    session_id: z.string().min(1).max(256),
    preset: z.enum(['full', 'recent']).optional(),
    select: contextSelectSchema.optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    cursor: z.string().min(1).max(4096).optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
  })
  .strict();

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
  tools: 3,
  commands: 0,
});
export function contextSelection(args) {
  return {
    ...(args.preset === 'recent' ? RECENT_SELECTION : FULL_SELECTION),
    ...Object.fromEntries(
      Object.entries(args.select ?? {}).filter(([, value]) => value !== undefined),
    ),
  };
}
