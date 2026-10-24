import { appendUnits, READ_CONTRACT, READ_SNAPSHOT_LIMIT } from './context-read.mjs';
import { jsonBytes } from './response-budget.mjs';

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

export async function captureSessionRead(reader, context, args) {
  let result;
  try {
    result = await reader.read(context);
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
          row.total < row.selected,
      ))
  )
    throw new Error('INVALID_SESSION_READ');
  const target = { units: [], accountedBytes: 0 };
  const ids = new Set();
  for (const item of result.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      !item.id ||
      item.id.length > 256 ||
      ids.has(item.id) ||
      typeof item.kind !== 'string' ||
      !item.kind ||
      item.kind.length > 64 ||
      typeof item.text !== 'string' ||
      (item.title !== undefined && typeof item.title !== 'string') ||
      (item.preview !== undefined && typeof item.preview !== 'string') ||
      (item.related !== undefined &&
        (!Array.isArray(item.related) ||
          item.related.length > 32 ||
          item.related.some(
            (link) => typeof link.id !== 'string' || typeof link.relation !== 'string',
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
    ids.add(item.id);
    const start = target.units.length;
    appendUnits(target, {
      type: item.kind,
      source: { reader_item: item.id },
      message: { role: 'custom', customType: item.kind, content: item.text },
    });
    for (const unit of target.units.slice(start)) {
      unit.kind = item.kind;
      if (item.title) unit.title = item.title.slice(0, 256);
      if (item.source) unit.provenance = structuredClone(item.source);
    }
    if (target.units[start]) {
      if (item.preview) target.units[start].preview = item.preview.slice(0, 4096);
      if (item.related) target.units[start].related = structuredClone(item.related);
    }
  }
  for (const item of result.items)
    if (item.related?.some((link) => !ids.has(link.id))) throw new Error('INVALID_SESSION_READ');
  const native = result.native ? await context.nativeRead() : null;
  target.units.push(...(native?.units ?? []));
  if (jsonBytes(target.units) > READ_SNAPSHOT_LIMIT) throw new Error('READ_SNAPSHOT_TOO_LARGE');
  return {
    contract: READ_CONTRACT,
    view: 'adapted',
    reader: {
      id: reader.id,
      ...(result.coverage ? { coverage: structuredClone(result.coverage) } : {}),
    },
    session_id: args.session_id,
    leaf_id: native?.leaf_id ?? context.owner.leaf_id,
    selection: native?.selection ?? null,
    omissions: native?.omissions ?? null,
    units: target.units,
    live: native?.live ?? null,
  };
}
