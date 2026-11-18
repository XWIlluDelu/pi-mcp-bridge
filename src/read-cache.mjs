import { randomUUID } from 'node:crypto';
import { contextSelection } from './read-schema.mjs';
import { jsonBytes } from './response-budget.mjs';
import { READ_SNAPSHOT_LIMIT, renderPreparedContextRead } from './context-read.mjs';
import {
  navigationDocuments,
  navigationOrder,
  navigationRow,
  documentAtoms,
} from './read-navigation.mjs';

const encodeHandle = (...parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');
const validToken = (token) => typeof token === 'string' && /^[0-9a-f-]{36}$/.test(token);
const validIndex = (index) => Number.isSafeInteger(index) && index >= 0;

function decodeHandle(value, error) {
  try {
    if (/^[A-Za-z0-9_-]+$/.test(value)) {
      const parts = JSON.parse(Buffer.from(value, 'base64url').toString());
      if (Array.isArray(parts) && parts.length === 3) return parts;
    }
  } catch {}
  throw new Error(error);
}

// Immutable sanitized history, not a version-dependent acceleration cache.
// Missing snapshots are never reacquired to reconstruct an old cursor.
export class ContextReadCache {
  constructor({ maxBytes = READ_SNAPSHOT_LIMIT, maxEntries = 16 } = {}) {
    Object.assign(this, { maxBytes, maxEntries, accountedBytes: 0, entries: new Map() });
  }
  lookup(cursor) {
    const [token, offset, part] = decodeHandle(cursor, 'INVALID_CURSOR');
    if (!validToken(token) || !validIndex(offset) || !validIndex(part) || (!offset && !part))
      throw new Error('INVALID_CURSOR');
    const entry = this.entries.get(token);
    if (!entry) throw new Error('STALE_CURSOR');
    if (offset >= entry.length || (entry.snapshot.documents && part))
      throw new Error('INVALID_CURSOR');
    return { position: { token, offset, part }, entry };
  }
  identity(cursor) {
    return this.lookup(cursor).entry.identity;
  }
  reference(ref) {
    const [tag, token, index] = decodeHandle(ref, 'INVALID_READ_REFERENCE');
    if (tag !== 'ref' || !validToken(token) || !validIndex(index))
      throw new Error('INVALID_READ_REFERENCE');
    const entry = this.entries.get(token);
    if (!entry) throw new Error('STALE_READ_REFERENCE');
    const document = entry.snapshot.documents?.[index];
    if (!document) throw new Error('INVALID_READ_REFERENCE');
    return { token, entry, document };
  }
  referenceIdentity(ref) {
    return this.reference(ref).entry.identity;
  }
  expand(refs, identity) {
    const resolved = refs.map((ref) => this.reference(ref));
    const first = resolved[0];
    if (
      JSON.stringify(first.entry.identity) !== JSON.stringify(identity) ||
      resolved.some((r) => r.token !== first.token)
    )
      throw new Error('INVALID_READ_REFERENCE');
    if (resolved.some(({ document }) => document.request)) {
      if (refs.length !== 1) throw new Error('INVALID_READ_REFERENCE');
      return { sourceRequest: first.document.request };
    }
    this.entries.delete(first.token);
    this.entries.set(first.token, first.entry);
    const { documents, order, query, ...snapshot } = first.entry.snapshot;
    const selected = new Map();
    for (const { document } of resolved)
      for (const atom of documentAtoms(documents, document))
        selected.set(
          atom.child === undefined ? atom.position : `${atom.position}:${atom.child}`,
          atom,
        );
    const units = [...selected.values()]
      .filter(({ position, child }) => child === undefined || !selected.has(position))
      .sort((a, b) => a.position - b.position || a.child - b.child)
      .map(({ unit }) => unit);
    return { ...snapshot, units, presentation: 'source', expanded_refs: refs };
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
  insert(token, snapshot, identity, length) {
    const accountedBytes = jsonBytes(snapshot) * 4 + length * 256;
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
      length,
      pins: 0,
    });
    this.accountedBytes += accountedBytes;
  }
  render(
    snapshot,
    args,
    { token = randomUUID(), cursor, identity, resultBudget, live, runtimeEvents, readPins } = {},
  ) {
    let rows;
    if (snapshot.documents) {
      const ref = (index) => encodeHandle('ref', token, index);
      const { documents, order, query } = snapshot;
      rows = {
        length: order.length,
        at: (offset) => navigationRow(documents, order[offset], ref, query),
      };
    }
    const result = renderPreparedContextRead(snapshot, args, {
      rows,
      cursor,
      encode: (offset, part) => encodeHandle(token, offset, part),
      resultBudget,
      live,
      runtimeEvents,
    });
    if (result.next_cursor || rows?.length) {
      if (!this.entries.has(token))
        this.insert(token, snapshot, identity, rows?.length ?? snapshot.units.length);
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
    const { units, ...capture } = snapshot;
    const documents = navigationDocuments({ units, ...capture, request: args });
    return this.render(
      {
        ...capture,
        request: args,
        documents,
        order: navigationOrder(documents, query),
        presentation: 'preview',
        query,
      },
      args,
      options,
    );
  }
  clear() {
    this.entries.clear();
    this.accountedBytes = 0;
  }
}
