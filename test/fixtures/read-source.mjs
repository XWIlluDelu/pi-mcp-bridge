import assert from 'node:assert/strict';
// Exercise the public navigation -> reference workflow when a test needs the
// saved source shape rather than its ordinary reading preview.
export async function readSource(bridge, args) {
  const read = typeof bridge === 'function' ? bridge : (request) => bridge.read(request);
  const first = await read(args);
  const references = [];
  const seenCursors = new Set();
  const continuePage = async (cursor) => {
    assert.ok(!seenCursors.has(cursor), 'Reference workflow must advance its cursor');
    seenCursors.add(cursor);
    return read({ cursor, max_bytes: args.max_bytes });
  };
  let page = first;
  for (;;) {
    references.push(
      ...page.items
        .filter((item) => item.type !== 'source_context')
        .map((item) => item.ref)
        .filter(Boolean),
    );
    if (!page.next_cursor) break;
    page = await continuePage(page.next_cursor);
  }
  const items = [];
  for (let index = 0; index < references.length; index += 8) {
    page = await read({ refs: references.slice(index, index + 8), max_bytes: args.max_bytes });
    for (;;) {
      items.push(...page.items);
      if (!page.next_cursor) break;
      page = await continuePage(page.next_cursor);
    }
  }
  return { ...first, items, next_cursor: null };
}
