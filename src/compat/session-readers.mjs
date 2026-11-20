import { z } from 'zod';
import { appendSnapshotUnit, READ_CONTRACT, validateReadEntryIds } from '../read/context-read.mjs';
import { READ_SNAPSHOT_LIMIT, readSnapshotBytes } from '../read/read-snapshots.mjs';
import { jsonBytes } from '../mcp/response-budget.mjs';
import { CONTENT_KINDS, contentKind, contextSelection } from '../read/read-schema.mjs';
import { matchesReadText } from '../read/read-navigation.mjs';

const count = z.number().int().nonnegative();
const kindName = z.string().min(1).max(64);
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
      title: z.string().optional(),
      preview: z.string().optional(),
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
  const nativeRead = (options) => {
    if (
      options !== undefined &&
      (!options ||
        typeof options !== 'object' ||
        Array.isArray(options) ||
        Object.keys(options).some((key) => key !== 'entry_ids'))
    )
      throw new Error('INVALID_SESSION_READ');
    const ids =
      options?.entry_ids === undefined ? undefined : validateReadEntryIds(options.entry_ids);
    if (nativeCapture && ids !== undefined && JSON.stringify(ids) !== JSON.stringify(entryIds))
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
  const parsed = readerResponse.safeParse(value);
  if (!parsed.success) throw new Error('INVALID_SESSION_READ');
  const result = parsed.data;
  const target = { units: [], accountedBytes: 0 };
  const { content } = contextSelection(args);
  const enabledKind = (kind) => content[kind] !== false && content[kind] !== 0;
  const items = new Map();
  const keep = new Set();
  for (const item of result.items) {
    if (items.has(item.id)) throw new Error('INVALID_SESSION_READ');
    const kind = contentKind(item.kind);
    const title = item.title?.slice(0, 256);
    const preview = item.preview?.slice(0, 4096);
    const enabled = enabledKind(kind);
    items.set(item.id, { item, kind, title, preview, enabled });
    if (enabled && (!query || matchesReadText(title, preview, item.text, query))) keep.add(item.id);
  }
  for (const { item } of items.values())
    if (item.related?.some((link) => !items.has(link.id))) throw new Error('INVALID_SESSION_READ');
  // A matching item must keep the sources reachable through its related refs.
  for (const id of keep)
    for (const link of items.get(id).item.related ?? [])
      if (items.get(link.id).enabled) keep.add(link.id);
  for (const { item, kind, title, preview } of items.values()) {
    if (!keep.has(item.id)) continue;
    const originalKind =
      !CONTENT_KINDS.includes(item.kind) && kind === 'native' ? { content_kind: item.kind } : {};
    appendSnapshotUnit(target, {
      type: kind,
      source: { reader_item: item.id, ...originalKind },
      message: { role: 'custom', customType: item.kind, content: item.text },
      kind,
      title: title || undefined,
      preview: preview || undefined,
      provenance: item.source && { ...item.source, ...originalKind },
      branch_relation: item.branch_relation,
      related: item.related,
    });
  }
  const native = result.native ? await nativeRead() : nativeCapture ? await nativeCapture : null;
  if (
    result.native &&
    target.accountedBytes + readSnapshotBytes(native.units, native.units.length) >
      READ_SNAPSHOT_LIMIT
  )
    throw new Error('READ_SNAPSHOT_TOO_LARGE');
  return {
    contract: READ_CONTRACT,
    view: 'adapted',
    reader: {
      id: reader.id,
      ...(result.coverage
        ? {
            coverage: result.coverage.map((row) => ({
              ...structuredClone(row),
              ...(!enabledKind(contentKind(row.type)) ? { selected: 0 } : {}),
            })),
          }
        : {}),
    },
    session_id: args.session_id,
    leaf_id: native ? native.leaf_id : context.owner.leaf_id,
    selection: result.native ? (native.selection ?? null) : null,
    omissions: result.native ? (native.omissions ?? null) : null,
    units: result.native ? target.units.concat(native.units) : target.units,
    live: result.native ? (native.live ?? null) : null,
  };
}
