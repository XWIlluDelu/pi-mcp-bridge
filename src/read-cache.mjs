import { randomUUID } from 'node:crypto';
import { contextSelection } from './read-schema.mjs';
import { jsonBytes } from './response-budget.mjs';
import { READ_SNAPSHOT_LIMIT, renderPreparedContextRead } from './context-read.mjs';
import { navigationDocuments, navigationRows, documentUnits } from './read-navigation.mjs';

function decode(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const [token, before, ...extra] = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      extra.length ||
      typeof token !== 'string' ||
      !/^[0-9a-f-]{36}$/.test(token) ||
      !Number.isSafeInteger(before) ||
      before < 1
    )
      throw new Error();
    return { token, before };
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
const encode = (token, before) =>
  Buffer.from(JSON.stringify([token, before])).toString('base64url');

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
    if (position.before > (entry.snapshot.navigation?.rows.length ?? entry.snapshot.units.length))
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
    const units = [...new Set(resolved.map((r) => r.index))].flatMap((index) =>
      documentUnits(snapshot, snapshot.navigation.documents[index]),
    );
    return {
      ...snapshot,
      units,
      navigation: undefined,
      detail: 'full',
      request: { ...snapshot.request, detail: 'full' },
      expanded_refs: refs,
      selection: snapshot.selection,
    };
  }
  get(args, identity) {
    const { position, entry } = this.lookup(args.cursor),
      snapshot = entry.snapshot,
      selection =
        snapshot.view === 'adapted' ? contextSelection(snapshot.request) : snapshot.selection,
      leaf =
        snapshot.view === 'adapted' && snapshot.request.leaf_id !== undefined
          ? snapshot.request.leaf_id
          : snapshot.leaf_id;
    if (
      JSON.stringify(identity) !== JSON.stringify(entry.identity) ||
      (args.session_id !== undefined && args.session_id !== snapshot.session_id) ||
      (args.view !== undefined && args.view !== (snapshot.view ?? 'session')) ||
      (snapshot.view === 'runtime' &&
        [args.preset, args.select, args.leaf_id].some((v) => v !== undefined)) ||
      (args.leaf_id !== undefined && args.leaf_id !== leaf) ||
      (args.detail !== undefined && args.detail !== snapshot.request?.detail) ||
      (args.types !== undefined &&
        JSON.stringify(args.types) !== JSON.stringify(snapshot.request?.types))
    )
      throw new Error('STALE_CURSOR');
    if (args.preset !== undefined) {
      if (
        JSON.stringify(contextSelection({ detail: snapshot.request?.detail, ...args })) !==
        JSON.stringify(selection)
      )
        throw new Error('STALE_CURSOR');
    } else if (
      Object.entries(args.select ?? {}).some(
        ([key, value]) => value !== undefined && value !== selection[key],
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
        detail: 'brief',
        ...(snapshot.navigation.query
          ? { query: snapshot.navigation.query, matches: snapshot.navigation.rows.length }
          : {}),
        ...(snapshot.navigation.types ? { types: snapshot.navigation.types } : {}),
        units: snapshot.navigation.rows.map((row) => ({
          ...row,
          ref: reference(row.ref),
          ...(row.related
            ? { related: row.related.map((link) => ({ ...link, ref: reference(link.ref) })) }
            : {}),
        })),
      };
    }
    const result = renderPreparedContextRead(rendered, args, {
      cursor,
      encode: (before) => encode(token, before),
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
      request: { ...args, detail: 'brief' },
      navigation: {
        documents: navigationDocuments(snapshot),
        task_order: !query && snapshot.view !== 'runtime',
        ...(query ? { query } : {}),
        ...(args.types ? { types: args.types } : {}),
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
