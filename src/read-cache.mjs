import { randomUUID } from 'node:crypto';
import { contextSelection } from './read-schema.mjs';
import { jsonBytes } from './response-budget.mjs';
import { READ_SNAPSHOT_LIMIT, renderPreparedContextRead } from './context-read.mjs';

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
    if (position.before > entry.snapshot.units.length) throw new Error('INVALID_CURSOR');
    return { position, entry };
  }
  identity(cursor) {
    return this.lookup(cursor).entry.identity;
  }
  get(args, identity) {
    const { position, entry } = this.lookup(args.cursor),
      snapshot = entry.snapshot;
    if (
      JSON.stringify(identity) !== JSON.stringify(entry.identity) ||
      (args.session_id !== undefined && args.session_id !== snapshot.session_id) ||
      (args.leaf_id !== undefined && args.leaf_id !== snapshot.leaf_id)
    )
      throw new Error('STALE_CURSOR');
    if (args.preset !== undefined) {
      if (JSON.stringify(contextSelection(args)) !== JSON.stringify(snapshot.selection))
        throw new Error('STALE_CURSOR');
    } else if (
      Object.entries(args.select ?? {}).some(
        ([key, value]) => value !== undefined && value !== snapshot.selection[key],
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
    const result = renderPreparedContextRead(snapshot, args, {
      cursor,
      encode: (before) => encode(token, before),
      resultBudget,
      live,
      runtimeEvents,
    });
    if (result.next_cursor) {
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
  clear() {
    this.entries.clear();
    this.accountedBytes = 0;
  }
}
