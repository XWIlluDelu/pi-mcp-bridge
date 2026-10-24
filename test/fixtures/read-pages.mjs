import assert from 'node:assert/strict';
import { prepareContextRead as prepare } from '../../src/context-read.mjs';
import { sdk } from './pi.mjs';
export const prepareContextRead = (data, args) => prepare(data, args, sdk);
import { ContextReadCache } from '../../src/read-cache.mjs';

// Unit-test convenience only: production acquisition and authorization live in Bridge.
const cache = new ContextReadCache();
export function renderContextRead(data, args) {
  const identity = {
    session_id: args.session_id ?? cache.identity(args.cursor).session_id,
    file: 'fixture',
    native_id: data.header.id,
  };
  if (args.cursor) {
    const captured = cache.get(args, identity);
    return cache.render(captured.snapshot, args, { ...captured, identity });
  }
  const { live, ...snapshot } = prepareContextRead(data, args);
  return cache.render(snapshot, args, { identity, live });
}
export function assertContextReadResponse(page, args = {}) {
  assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= (args.max_bytes ?? 24000));
  assert.ok(page.selection && page.omissions.selection && page.omissions.capacity);
  assert.ok(page.next_cursor === null || typeof page.next_cursor === 'string');
  assert.equal(Boolean(page.next_cursor), page.omissions.capacity.remaining_units > 0);
  for (const item of page.items) {
    assert.equal(typeof item.source.entry_id, 'string');
  }
}
export const chronological = (pages) => [...pages].reverse().flatMap((page) => page.items);
