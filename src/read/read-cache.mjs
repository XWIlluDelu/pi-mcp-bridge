import { randomUUID } from 'node:crypto';
import { contextSelection } from './read-schema.mjs';
import { READ_SNAPSHOT_LIMIT, ReadSnapshots } from './read-snapshots.mjs';
import { renderPreparedContextRead } from './read-render.mjs';
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
export class ContextReadCache extends ReadSnapshots {
  constructor({ maxBytes = READ_SNAPSHOT_LIMIT, maxEntries = 64 } = {}) {
    super(maxBytes, maxEntries);
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
  target(args) {
    if (args.session_id !== undefined) return args.session_id;
    const { entry } = args.refs ? this.reference(args.refs[0]) : this.lookup(args.cursor);
    return entry.identity.session_id;
  }
  expand(refs, identity) {
    const resolved = refs.map((ref) => this.reference(ref));
    const expected = JSON.stringify(identity);
    if (resolved.some((r) => JSON.stringify(r.entry.identity) !== expected))
      throw new Error('INVALID_READ_REFERENCE');
    if (resolved.some(({ document }) => document.request)) {
      if (refs.length !== 1) throw new Error('INVALID_READ_REFERENCE');
      return { sourceRequest: resolved[0].document.request };
    }
    const tokenOrder = new Map();
    const selected = new Map();
    for (const { token, entry, document } of resolved) {
      this.touch(token, entry);
      if (!tokenOrder.has(token)) tokenOrder.set(token, tokenOrder.size);
      const captureIndex = tokenOrder.get(token);
      for (const atom of documentAtoms(entry.snapshot.documents, document))
        selected.set(
          atom.child === undefined
            ? `${token}:${atom.position}`
            : `${token}:${atom.position}:${atom.child}`,
          { ...atom, token, captureIndex },
        );
    }
    const units = [...selected.values()]
      .filter(
        ({ token, position, child }) =>
          child === undefined || !selected.has(`${token}:${position}`),
      )
      .sort(
        (a, b) =>
          a.captureIndex - b.captureIndex ||
          a.position - b.position ||
          (a.child ?? -1) - (b.child ?? -1),
      )
      .map(({ unit }) => unit);
    const { documents, order, query, ...snapshot } = resolved[0].entry.snapshot;
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
    this.touch(position.token, entry);
    return { token: position.token, snapshot, cursor: position };
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
      if (
        !this.entries.has(token) &&
        !this.insert(token, { snapshot, identity }, rows?.length ?? snapshot.units.length)
      )
        throw new Error('READ_SNAPSHOT_TOO_LARGE');
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
    const documents = navigationDocuments({ ...capture, units, request: args });
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
}
