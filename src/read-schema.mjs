import { z } from 'zod';

const count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
export const CONTENT_KINDS = Object.freeze([
  'input',
  'assistant',
  'thinking',
  'tool',
  'summary',
  'memory',
  'system',
  'command',
  'native',
]);
// Native source-unit names differ from public content controls. Extensions may
// expose additional source kinds; they remain readable under the native switch.
export function contentKind(kind) {
  const mapped =
    {
      prompt: 'input',
      text: 'assistant',
      tool_call: 'tool',
      tool_result: 'tool',
      nested_call: 'tool',
      custom: 'native',
    }[kind] ?? kind;
  return CONTENT_KINDS.includes(mapped) ? mapped : 'native';
}
export const DEFAULT_RANGE = Object.freeze({ recent: 3, earliest: 0 });
export const DEFAULT_CONTENT = Object.freeze({
  input: true,
  assistant: -1,
  thinking: 1,
  tool: 1,
  summary: 2,
  memory: 3,
  system: false,
  command: 0,
  native: true,
});
export const ALL_CONTENT = Object.freeze({
  input: true,
  assistant: -1,
  thinking: -1,
  tool: -1,
  summary: -1,
  memory: -1,
  system: true,
  command: -1,
  native: true,
});
export const rangeSchema = z
  .object({
    recent: count
      .describe('Last N input turns; default 3; -1 includes all effective turns.')
      .optional(),
    earliest: count
      .describe('Also include first N input turns; default 0; overlaps are deduplicated.')
      .optional(),
  })
  .strict();
export const contentSchema = z
  .object({
    input: z
      .boolean()
      .describe('Include the input message of each selected turn; default true.')
      .optional(),
    assistant: count
      .describe(
        'Last N assistant messages with body text or failure status per turn; -1 includes all (default). All text blocks of a selected message stay together.',
      )
      .optional(),
    thinking: count
      .describe(
        'Last N messages with readable thinking per turn; default 1. 0 omits, -1 includes all. Selected thinking blocks stay in source order.',
      )
      .optional(),
    tool: count
      .describe(
        'Last N logical tool operations per turn; default 1. A call and its paired result count once; a codemode batch counts once. 0 omits, -1 includes all.',
      )
      .optional(),
    summary: count
      .describe(
        'Summary background, independent of turns: 0 omits, -1 includes all. Native active summaries form one group; readers select their own summary items. Default 2.',
      )
      .optional(),
    memory: count
      .describe(
        'Last N eligible memory items supplied by the reader, independent of turns; default 3; 0 omits, -1 includes all.',
      )
      .optional(),
    system: z
      .boolean()
      .describe('Include native system instructions and sections; default false.')
      .optional(),
    command: count
      .describe(
        'Last N native shell command records, independent of turns; default 0; -1 includes all.',
      )
      .optional(),
    native: z
      .boolean()
      .describe(
        'Include other custom/native context in selected turns and global prefixes; default true.',
      )
      .optional(),
  })
  .strict();

export const readSchema = z
  .object({
    session_id: z.string().min(1).max(256).optional(),
    view: z
      .enum(['session', 'runtime'])
      .describe(
        'Omit for automatic reader routing; session forces native context; runtime reads the request-stage capture.',
      )
      .optional(),
    range: rangeSchema.optional(),
    content: contentSchema.optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    cursor: z.string().min(1).max(4096).optional(),
    refs: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(8)
      .describe(
        'Expand up to eight references from one frozen capture into original selected source content.',
      )
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
      [args.cursor, args.view, args.range, args.content, args.leaf_id].every(
        (v) => v === undefined,
      ),
    {
      message: 'References accept only optional session_id and max_bytes',
    },
  )
  .refine(
    (args) =>
      args.view !== 'runtime' ||
      (args.range === undefined &&
        args.leaf_id === undefined &&
        Object.values(args.content ?? {}).every(
          (value) => typeof value === 'boolean' || value === 0 || value === -1,
        )),
    {
      message:
        'Runtime captures accept content switches (booleans or 0/-1), but no turn range, finite counts or leaf override',
    },
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
        'Case-insensitive literal text across the reader’s full effective content, independent of read sampling.',
      ),
    view: z.enum(['session', 'runtime']).optional(),
    content: z
      .array(z.enum(CONTENT_KINDS))
      .min(1)
      .max(CONTENT_KINDS.length)
      .describe(
        'Content kinds to search; omit for all supported kinds. Uses the same names as read.content.',
      )
      .optional(),
    leaf_id: z.string().min(1).max(128).nullable().optional(),
    max_bytes: z.number().int().min(4096).max(65536).optional(),
  })
  .strict()
  .refine((args) => args.view !== 'runtime' || args.leaf_id === undefined, {
    message: 'Runtime captures do not accept a leaf override',
  });

export function contextSelection(args = {}) {
  return {
    range: args.view === 'runtime' ? null : { ...DEFAULT_RANGE, ...defined(args.range) },
    content: {
      ...(args.view === 'runtime' ? ALL_CONTENT : DEFAULT_CONTENT),
      ...defined(args.content),
    },
  };
}
function defined(value) {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, item]) => item !== undefined));
}
