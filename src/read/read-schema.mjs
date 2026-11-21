import { z } from 'zod';
import { utf16String } from '../mcp/schema.mjs';

const count = z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER);
// Native source-unit names differ from public content controls. Extensions may
// expose additional source kinds; they remain readable under the native switch.
const contentKindAliases = {
  prompt: 'input',
  text: 'assistant',
  tool_call: 'tool',
  tool_result: 'tool',
  nested_call: 'tool',
  custom: 'native',
};
export function contentKind(kind) {
  const mapped = contentKindAliases[kind] ?? kind;
  return CONTENT_KINDS.includes(mapped) ? mapped : 'native';
}
// UTF-8 budget for one structured read page when max_bytes is omitted.
export const DEFAULT_READ_BYTES = 24000;
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
export const CONTENT_KINDS = Object.freeze(Object.keys(DEFAULT_CONTENT));
export const ALL_CONTENT = Object.freeze(
  Object.fromEntries(
    CONTENT_KINDS.map((kind) => [kind, typeof DEFAULT_CONTENT[kind] === 'boolean' ? true : -1]),
  ),
);
const rangeSchema = z
  .object({
    recent: count.optional(),
    earliest: count.optional(),
  })
  .strict();
const contentSchema = z
  .object({
    input: z.boolean().optional(),
    assistant: count.optional(),
    thinking: count.optional(),
    tool: count.optional(),
    summary: count.optional(),
    memory: count.optional(),
    system: z.boolean().optional(),
    command: count.optional(),
    native: z.boolean().optional(),
  })
  .strict();

const view = z.enum(['session', 'runtime']);
export const readSchema = z
  .object({
    session_id: utf16String(256).min(1).optional(),
    query: utf16String(2048, { trim: true }).min(1).optional(),
    view: view.optional(),
    range: rangeSchema.optional(),
    content: contentSchema.optional(),
    leaf_id: utf16String(128).min(1).nullable().optional(),
    cursor: utf16String(4096).min(1).optional(),
    refs: z.array(utf16String(4096).min(1)).min(1).max(8).optional(),
    include_images: z.boolean().optional(),
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
      [args.cursor, args.query, args.view, args.range, args.content, args.leaf_id].every(
        (v) => v === undefined,
      ),
    {
      message: 'References accept only optional session_id, include_images and max_bytes',
    },
  )
  .refine((args) => !args.cursor || args.query === undefined, {
    message: 'Cursor continuations inherit query from the original read',
  })
  .refine((args) => !args.include_images || Boolean(args.refs), {
    message: 'include_images requires refs',
  })
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
