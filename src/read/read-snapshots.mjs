import { jsonBytes } from '../mcp/response-budget.mjs';

export const READ_SNAPSHOT_LIMIT = 32 * 1024 * 1024;
export const readSnapshotBytes = (value, count) => jsonBytes(value) * 4 + count * 256;

// Both read stores evict the least recently used capture that can be discarded.
// A batch can pin its public references while other reads are admitted.
export class ReadSnapshots {
  constructor(maxBytes, maxEntries) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.clear();
  }
  clear() {
    this.entries = new Map();
    this.accountedBytes = 0;
  }
  delete(key) {
    const entry = this.entries.get(key);
    if (entry) this.accountedBytes -= entry.bytes;
    this.entries.delete(key);
  }
  touch(key, entry) {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
  insert(key, entry, length) {
    this.delete(key);
    const bytes = readSnapshotBytes(entry.snapshot, length);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    while (this.entries.size >= this.maxEntries || this.accountedBytes + bytes > this.maxBytes) {
      const evictable = this.entries.entries().find(([, capture]) => !capture.pins);
      if (!evictable) throw new Error('READ_CACHE_BUSY');
      this.delete(evictable[0]);
    }
    this.entries.set(key, { ...entry, length, bytes, pins: 0 });
    this.accountedBytes += bytes;
    return true;
  }
}
