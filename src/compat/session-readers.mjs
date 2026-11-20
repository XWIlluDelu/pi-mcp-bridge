import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { parseAs } from '../mcp/schema.mjs';
import { appendSnapshotUnit, READ_CONTRACT, validateReadEntryIds } from '../read/context-read.mjs';
import { READ_SNAPSHOT_LIMIT, readSnapshotBytes } from '../read/read-snapshots.mjs';
import { jsonBytes } from '../mcp/response-budget.mjs';
import { CONTENT_KINDS, contentKind, contextSelection } from '../read/read-schema.mjs';
import { matchesReadText } from '../read/read-navigation.mjs';

const count = z.number().int().nonnegative();
const kindName = z.string().min(1).max(64);
const nativeOptions = z.strictObject({ entry_ids: z.unknown().optional() });
const clipped = (limit) =>
  z
    .string()
    .transform((value) => value.slice(0, limit))
    .optional();
const readerResponse = z.object({
  native: z.boolean().optional(),
  coverage: z
    .array(
      z
        .looseObject({
          type: kindName,
          selected: count,
          total: count,
          excluded: count.optional(),
        })
        .refine(({ selected, total, excluded = 0 }) => excluded <= total - selected),
    )
    .max(16)
    .optional(),
  items: z.array(
    z.object({
      id: z.string().min(1).max(256),
      kind: kindName,
      text: z.string(),
      title: clipped(256),
      preview: clipped(4096),
      source: z
        .record(z.string(), z.unknown())
        .refine((value) => jsonBytes(value) <= 8192)
        .optional(),
      branch_relation: z.enum(['on_branch', 'off_branch', 'unknown']).optional(),
      related: z
        .array(z.looseObject({ id: z.string(), relation: z.string() }))
        .max(32)
        .optional(),
    }),
  ),
});

const readerError = (cause) =>
  Object.assign(new Error('SESSION_READER_FAILED', { cause }), {
    ...(/^[A-Z0-9_]{3,64}$/.test(cause?.message ?? '') ? { detail: cause.message } : {}),
  });

// A distinct capability under the shared module lifecycle, not a replacement
// for input mappings. Each reader assesses the target session's own evidence.
export class SessionReaders {
  constructor() {
    this.readers = new Map();
  }
  register(id, reader) {
    if (
      typeof id !== 'string' ||
      !id ||
      this.readers.has(id) ||
      typeof reader?.matches !== 'function' ||
      typeof reader?.read !== 'function'
    )
      throw new Error('INVALID_SESSION_READER');
    const registration = { id, matches: reader.matches, read: reader.read };
    this.readers.set(id, registration);
    return () => {
      if (this.readers.get(id) === registration) this.readers.delete(id);
    };
  }
  async select(context) {
    const matches = [];
    try {
      for (const reader of this.readers.values())
        if (await reader.matches(context)) matches.push(reader);
    } catch (cause) {
      throw readerError(cause);
    }
    if (matches.length > 1) throw new Error('SESSION_READER_CONFLICT');
    return matches[0];
  }
}

export async function captureSessionRead(reader, context, args, query) {
  let nativeCapture, entryIds;
  const nativeRead = (options = {}) => {
    const { entry_ids } = parseAs(nativeOptions, options, 'INVALID_SESSION_READ');
    const ids = entry_ids === undefined ? undefined : validateReadEntryIds(entry_ids);
    if (nativeCapture && ids !== undefined && !isDeepStrictEqual(ids, entryIds))
      throw new Error('INVALID_SESSION_READ');
    if (!nativeCapture) {
      entryIds = ids;
      nativeCapture = Promise.resolve().then(() =>
        context.nativeRead(ids === undefined ? undefined : { entry_ids: ids }),
      );
    }
    return nativeCapture;
  };
  let value;
  try {
    value = await reader.read({ ...context, nativeRead });
  } catch (cause) {
    throw readerError(cause);
  }
  const result = parseAs(readerResponse, value, 'INVALID_SESSION_READ');
  const target = { units: [], accountedBytes: 0 };
  const { content } = contextSelection(args);
  const enabled = (kind) => Boolean(content[contentKind(kind)]);
  const items = new Map(result.items.map((item) => [item.id, item]));
  if (items.size !== result.items.length) throw new Error('INVALID_SESSION_READ');
  const keep = new Set();
  for (const item of result.items) {
    if (item.related?.some((link) => !items.has(link.id))) throw new Error('INVALID_SESSION_READ');
    if (
      enabled(item.kind) &&
      (!query || matchesReadText(item.title, item.preview, item.text, query))
    )
      keep.add(item);
  }
  // Set iteration also visits newly reached items, including transitive links.
  for (const item of keep)
    for (const { id } of item.related ?? []) {
      const related = items.get(id);
      if (enabled(related.kind)) keep.add(related);
    }
  for (const item of result.items) {
    if (!keep.has(item)) continue;
    const kind = contentKind(item.kind);
    const originalKind =
      !CONTENT_KINDS.includes(item.kind) && kind === 'native' ? { content_kind: item.kind } : {};
    appendSnapshotUnit(target, {
      type: kind,
      source: { reader_item: item.id, ...originalKind },
      message: { role: 'custom', customType: item.kind, content: item.text },
      kind,
      title: item.title || undefined,
      preview: item.preview || undefined,
      provenance: item.source && { ...item.source, ...originalKind },
      branch_relation: item.branch_relation,
      related: item.related,
    });
  }
  const capture = await (result.native ? nativeRead() : nativeCapture);
  const native = result.native ? capture : null;
  if (
    native &&
    target.accountedBytes + readSnapshotBytes(native.units, native.units.length) >
      READ_SNAPSHOT_LIMIT
  )
    throw new Error('READ_SNAPSHOT_TOO_LARGE');
  const info = { id: reader.id };
  if (result.coverage) {
    info.coverage = structuredClone(result.coverage);
    for (const row of info.coverage) if (!enabled(row.type)) row.selected = 0;
  }
  return {
    contract: READ_CONTRACT,
    view: 'adapted',
    reader: info,
    session_id: args.session_id,
    leaf_id: capture ? capture.leaf_id : context.owner.leaf_id,
    selection: native?.selection ?? null,
    omissions: native?.omissions ?? null,
    units: native ? target.units.concat(native.units) : target.units,
    live: native?.live ?? null,
  };
}
