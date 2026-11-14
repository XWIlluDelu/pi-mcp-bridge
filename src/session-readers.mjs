import {
  appendUnits,
  READ_CONTRACT,
  READ_SNAPSHOT_LIMIT,
  validateReadEntryIds,
} from './context-read.mjs';
import { jsonBytes } from './response-budget.mjs';
import { CONTENT_KINDS, contentKind, contextSelection } from './read-schema.mjs';
import { matchesReadText } from './read-navigation.mjs';

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
      throw new Error('SESSION_READER_FAILED', { cause });
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
  let result;
  try {
    result = await reader.read({ ...context, nativeRead });
  } catch (cause) {
    throw new Error('SESSION_READER_FAILED', { cause });
  }
  if (
    !result ||
    !Array.isArray(result.items) ||
    (result.native !== undefined && typeof result.native !== 'boolean')
  )
    throw new Error('INVALID_SESSION_READ');
  if (
    result.coverage !== undefined &&
    (!Array.isArray(result.coverage) ||
      result.coverage.length > 16 ||
      result.coverage.some(
        (row) =>
          !row ||
          typeof row.type !== 'string' ||
          !row.type ||
          row.type.length > 64 ||
          !Number.isSafeInteger(row.selected) ||
          row.selected < 0 ||
          !Number.isSafeInteger(row.total) ||
          row.total < row.selected ||
          (row.excluded !== undefined &&
            (!Number.isSafeInteger(row.excluded) ||
              row.excluded < 0 ||
              row.excluded > row.total - row.selected)),
      ))
  )
    throw new Error('INVALID_SESSION_READ');
  const target = { units: [], accountedBytes: 0 };
  const { content } = contextSelection(args);
  const items = new Map();
  const keep = new Set();
  for (const item of result.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 256 ||
      items.has(item.id) ||
      typeof item.kind !== 'string' ||
      !item.kind ||
      item.kind.length > 64 ||
      typeof item.text !== 'string' ||
      (item.title !== undefined && typeof item.title !== 'string') ||
      (item.preview !== undefined && typeof item.preview !== 'string') ||
      (item.branch_relation !== undefined &&
        !['on_branch', 'off_branch', 'unknown'].includes(item.branch_relation)) ||
      (item.related !== undefined &&
        (!Array.isArray(item.related) ||
          item.related.length > 32 ||
          item.related.some(
            (link) => typeof link?.id !== 'string' || typeof link.relation !== 'string',
          )))
    )
      throw new Error('INVALID_SESSION_READ');
    if (
      item.source !== undefined &&
      (!item.source ||
        typeof item.source !== 'object' ||
        Array.isArray(item.source) ||
        jsonBytes(item.source) > 8192)
    )
      throw new Error('INVALID_SESSION_READ');
    const kind = contentKind(item.kind);
    const title = item.title?.slice(0, 256);
    const preview = item.preview?.slice(0, 4096);
    const enabled = content[kind] !== false && content[kind] !== 0;
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
    appendUnits(target, {
      type: kind,
      source: { reader_item: item.id, ...originalKind },
      message: { role: 'custom', customType: item.kind, content: item.text },
    });
    Object.assign(target.units.at(-1), {
      kind,
      title: title || undefined,
      preview: preview || undefined,
      provenance: item.source && { ...structuredClone(item.source), ...originalKind },
      branch_relation: item.branch_relation,
      related: item.related && structuredClone(item.related),
    });
  }
  const native = result.native ? await nativeRead() : nativeCapture ? await nativeCapture : null;
  if (result.native) target.units.push(...native.units);
  if (jsonBytes(target.units) > READ_SNAPSHOT_LIMIT) throw new Error('READ_SNAPSHOT_TOO_LARGE');
  return {
    contract: READ_CONTRACT,
    view: 'adapted',
    reader: {
      id: reader.id,
      ...(result.coverage
        ? {
            coverage: result.coverage.map((row) => ({
              ...structuredClone(row),
              ...(content[contentKind(row.type)] === false || content[contentKind(row.type)] === 0
                ? { selected: 0 }
                : {}),
            })),
          }
        : {}),
    },
    session_id: args.session_id,
    leaf_id: native ? native.leaf_id : context.owner.leaf_id,
    selection: result.native ? (native.selection ?? null) : null,
    omissions: result.native ? (native.omissions ?? null) : null,
    units: target.units,
    live: result.native ? (native.live ?? null) : null,
  };
}
