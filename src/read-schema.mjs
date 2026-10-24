import { z } from 'zod';

const count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
export const contextSelectSchema = z
  .object({
    system: z
      .union([z.literal(-1), z.literal(0)])
      .describe(
        'Native system instructions/sections: 0 omits, -1 includes. Defaults to 0 except full.',
      )
      .optional(),
    summary: z
      .union([z.literal(-1), z.literal(0), z.literal(1)])
      .describe('Active native summaries: 0 omits; 1/-1 includes.')
      .optional(),
    recent_prompts: count.describe('Last N input turns; -1 includes all.').optional(),
    earliest_prompts: count.describe('Also include first N input turns; default 0.').optional(),
    text: count
      .describe('First N and last N assistant text blocks per selected input; -1 includes all.')
      .optional(),
    thinking: count
      .describe('First N and last N thinking blocks per selected input; default 0 outside full.')
      .optional(),
    tools: count
      .describe(
        'First N and last N logical tool units per input (at most 2N); a call and its paired result count once. Default 2 outside full. A codemode batch counts once; brief previews summarize its recorded operations. 0 also omits tool declarations.',
      )
      .optional(),
    commands: count
      .describe('Last N native shell command records, independently of selected prompts.')
      .optional(),
  })
  .strict();

export const readSchema = z
  .object({
    session_id: z.string().min(1).max(256).optional(),
    view: z
      .enum(['session', 'runtime'])
      .describe(
        'Omit for automatic reader routing; session forces native context, runtime reads the request-stage capture.',
      )
      .optional(),
    preset: z
      .enum(['latest', 'recent', 'full'])
      .describe(
        'Session scope: latest input (default), last 3 inputs, or all effective context. Detail does not change selection.',
      )
      .optional(),
    select: contextSelectSchema.optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    cursor: z.string().min(1).max(4096).optional(),
    refs: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(8)
      .describe('Expand references returned by read/search from one captured session.')
      .optional(),
    detail: z
      .enum(['brief', 'full'])
      .describe(
        'Browsing defaults to brief. Full returns selected source content. References expand to full content.',
      )
      .optional(),
    types: z
      .array(z.string().min(1).max(64))
      .max(16)
      .describe('Content kinds from returned item type values; filters brief browsing.')
      .optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
  })
  .strict()
  .refine(
    (args) => args.session_id !== undefined || args.cursor !== undefined || args.refs !== undefined,
    {
      message: 'Session ID, cursor or references required',
    },
  )
  .refine(
    (args) =>
      !args.refs ||
      [
        args.cursor,
        args.view,
        args.preset,
        args.select,
        args.leaf_id,
        args.types,
        args.detail,
      ].every((v) => v === undefined),
    { message: 'References accept only optional session_id and max_bytes' },
  )
  .refine((args) => args.detail !== 'full' || args.types === undefined, {
    message: 'Type filtering applies to brief browsing and search',
  })
  .refine(
    (args) =>
      args.view !== 'runtime' ||
      [args.preset, args.select, args.leaf_id].every((value) => value === undefined),
    { message: 'Runtime reads do not accept session selection or leaf overrides' },
  );

export const searchSchema = z
  .object({
    session_id: z.string().min(1).max(256),
    query: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .describe(
        'Case-insensitive literal text across the selected reader’s full effective content, not just the current page.',
      ),
    view: z.enum(['session', 'runtime']).optional(),
    types: z.array(z.string().min(1).max(64)).max(16).optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
  })
  .strict()
  .refine((args) => args.view !== 'runtime' || args.leaf_id === undefined, {
    message: 'Runtime captures do not accept a leaf override',
  });

export const FULL_SELECTION = Object.freeze({
  system: -1,
  summary: -1,
  recent_prompts: -1,
  earliest_prompts: 0,
  text: -1,
  thinking: -1,
  tools: -1,
  commands: -1,
});
export const RECENT_SELECTION = Object.freeze({
  system: 0,
  summary: 1,
  recent_prompts: 3,
  earliest_prompts: 0,
  text: -1,
  thinking: 0,
  tools: 2,
  commands: 0,
});
export const LATEST_SELECTION = Object.freeze({
  system: 0,
  summary: 1,
  recent_prompts: 1,
  earliest_prompts: 0,
  text: -1,
  thinking: 0,
  tools: 2,
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
