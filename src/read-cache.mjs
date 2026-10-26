import { randomUUID } from 'node:crypto';
import { contextSelection } from './read-schema.mjs';
import { jsonBytes } from './response-budget.mjs';
import { READ_SNAPSHOT_LIMIT, renderPreparedContextRead } from './context-read.mjs';
import {
  navigationDocuments,
  navigationRows,
  documentUnits,
  documentText,
  excerpt,
} from './read-navigation.mjs';

function decode(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const [token, offset, ...extra] = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      extra.length ||
      typeof token !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(token) ||
      !Number.isSafeInteger(offset) ||
      offset < 1
    )
      throw new Error();
    return { token, offset };
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
const encode = (token, offset) =>
  Buffer.from(JSON.stringify([token, offset])).toString('base64url');

// Immutable sanitized history, not a version-dependent acceleration cache.
// Missing snapshots are never reacquired to reconstruct an old cursor.
export class ContextReadCache {
  constructor({ maxBytes = READ_SNAPSHOT_LIMIT, maxEntries = 16 } = {}) {
    Object.assign(this, { maxBytes, maxEntries, accountedBytes: 0, entries: new Map() });
  }
  lookup(cursor) {
    const position = decode(cursor),
      entry = this.entries.get(position.token);
    if (!entry) throw new Error('STALE_CURSOR');
    if (position.offset > (entry.snapshot.navigation?.rows.length ?? entry.snapshot.units.length))
      throw new Error('INVALID_CURSOR');
    return { position, entry };
  }
  identity(cursor) {
    return this.lookup(cursor).entry.identity;
  }
  reference(ref) {
    try {
      if (typeof ref !== 'string' || !/^[A-Za-z0-9_-]+$/.test(ref)) throw new Error();
      const [tag, token, index, ...extra] = JSON.parse(Buffer.from(ref, 'base64url').toString());
      if (
        extra.length ||
        tag !== 'ref' ||
        typeof token !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(token) ||
        !Number.isSafeInteger(index) ||
        index < 0
      )
        throw new Error('INVALID_READ_REFERENCE');
      const entry = this.entries.get(token);
      if (!entry) throw new Error('STALE_READ_REFERENCE');
      const document = entry.snapshot.navigation?.documents[index];
      if (!document) throw new Error('INVALID_READ_REFERENCE');
      return { token, index, entry, document };
    } catch (error) {
      if (['STALE_READ_REFERENCE', 'INVALID_READ_REFERENCE'].includes(error.message)) throw error;
      throw new Error('INVALID_READ_REFERENCE');
    }
  }
  referenceIdentity(ref) {
    return this.reference(ref).entry.identity;
  }
  expand(refs, identity) {
    const resolved = refs.map((ref) => this.reference(ref));
    const first = resolved[0];
    if (
      resolved.some(
        (r) =>
          r.token !== first.token || JSON.stringify(r.entry.identity) !== JSON.stringify(identity),
      )
    )
      throw new Error('INVALID_READ_REFERENCE');
    this.entries.delete(first.token);
    this.entries.set(first.token, first.entry);
    const snapshot = first.entry.snapshot;
    const sourcePositions = new Map(snapshot.units.map((unit, index) => [unit, index]));
    for (const document of snapshot.navigation.documents)
      if (document.units && document.indices)
        document.units.forEach((unit, index) => sourcePositions.set(unit, document.indices[index]));
    const selected = new Map();
    for (const index of [...new Set(resolved.map((r) => r.index))].sort((a, b) => a - b)) {
      const document = snapshot.navigation.documents[index];
      documentUnits(snapshot, document).forEach((unit, i) => {
        if (!selected.has(unit))
          selected.set(
            unit,
            document.indices?.[i] ??
              sourcePositions.get(unit) ??
              snapshot.navigation.documents[document.parent]?.indices?.[0] ??
              index,
          );
      });
    }
    const units = [...selected].sort((a, b) => a[1] - b[1]).map(([unit]) => unit);
    return {
      ...snapshot,
      units,
      navigation: undefined,
      presentation: 'source',
      request: snapshot.request,
      expanded_refs: refs,
      selection: snapshot.selection,
    };
  }
  get(args, identity) {
    const { position, entry } = this.lookup(args.cursor),
      snapshot = entry.snapshot,
      selection = contextSelection(snapshot.request ?? {}),
      leaf = snapshot.request?.leaf_id !== undefined ? snapshot.request.leaf_id : snapshot.leaf_id;
    if (
      JSON.stringify(identity) !== JSON.stringify(entry.identity) ||
      (args.session_id !== undefined && args.session_id !== snapshot.session_id) ||
      (args.view !== undefined && args.view !== (snapshot.view ?? 'session')) ||
      (snapshot.view === 'runtime' && [args.range, args.leaf_id].some((v) => v !== undefined)) ||
      (args.leaf_id !== undefined && args.leaf_id !== leaf) ||
      ['range', 'content'].some((field) =>
        Object.entries(args[field] ?? {}).some(
          ([key, value]) => value !== undefined && value !== selection[field]?.[key],
        ),
      )
    )
      throw new Error('STALE_CURSOR');
    this.entries.delete(position.token);
    this.entries.set(position.token, entry);
    return { token: position.token, snapshot, cursor: position };
  }
  delete(token) {
    const entry = this.entries.get(token);
    if (entry) this.accountedBytes -= entry.accountedBytes;
    this.entries.delete(token);
  }
  insert(token, snapshot, identity) {
    const accountedBytes = jsonBytes(snapshot) * 4 + snapshot.units.length * 256;
    if (accountedBytes > this.maxBytes || this.maxEntries < 1)
      throw new Error('READ_SNAPSHOT_TOO_LARGE');
    while (
      this.entries.size >= this.maxEntries ||
      this.accountedBytes + accountedBytes > this.maxBytes
    ) {
      const evictable = [...this.entries].find(([, entry]) => !entry.pins);
      if (!evictable) throw new Error('READ_CACHE_BUSY');
      this.delete(evictable[0]);
    }
    this.entries.set(token, {
      snapshot,
      identity,
      accountedBytes,
      pins: 0,
    });
    this.accountedBytes += accountedBytes;
  }
  render(
    snapshot,
    args,
    { token = randomUUID(), cursor, identity, resultBudget, live, runtimeEvents, readPins } = {},
  ) {
    let rendered = snapshot;
    if (snapshot.navigation) {
      const reference = (index) =>
        Buffer.from(JSON.stringify(['ref', token, index])).toString('base64url');
      rendered = {
        ...snapshot,
        presentation: 'preview',
        ...(snapshot.navigation.query
          ? { query: snapshot.navigation.query, matches: snapshot.navigation.rows.length }
          : {}),
        units: snapshot.navigation.rows.map((row) => ({
          ...row,
          ...(row._latest
            ? {
                text: excerpt(
                  documentText(snapshot, snapshot.navigation.documents[row.ref]),
                  Number.MAX_SAFE_INTEGER,
                ),
                truncated: undefined,
              }
            : {}),
          ref: reference(row.ref),
          ...(row.related
            ? { related: row.related.map((link) => ({ ...link, ref: reference(link.ref) })) }
            : {}),
        })),
      };
    }
    const result = renderPreparedContextRead(rendered, args, {
      cursor,
      encode: (offset) => encode(token, offset),
      resultBudget,
      live,
      runtimeEvents,
    });
    if (result.next_cursor || (snapshot.navigation && rendered.units.length)) {
      if (!this.entries.has(token)) this.insert(token, snapshot, identity);
      if (readPins) {
        const entry = this.entries.get(token);
        entry.pins++;
        readPins.push(() => {
          entry.pins--;
        });
      }
    }
    return result;
  }
  navigate(snapshot, args, options, query) {
    const indexed = {
      ...snapshot,
      request: args,
      presentation: 'preview',
      navigation: {
        documents: navigationDocuments(snapshot),
        ...(query ? { query } : {}),
        ...(query
          ? {
              content: Object.entries(args.content ?? {})
                .filter(([, value]) => value !== 0 && value !== false)
                .map(([kind]) => kind),
            }
          : {}),
      },
    };
    indexed.navigation.rows = navigationRows(
      indexed,
      indexed.navigation.documents,
      (index) => index,
      indexed.navigation,
    );
    return this.render(indexed, args, options);
  }
  clear() {
    this.entries.clear();
    this.accountedBytes = 0;
  }
}
