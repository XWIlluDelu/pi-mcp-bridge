import { DEFAULT_READ_BYTES } from './read-schema.mjs';
import { jsonBytes, resultSize } from '../mcp/response-budget.mjs';
import { boundRuntimeEvents } from './runtime-events.mjs';
import { fitNavigationRow } from './read-navigation.mjs';

export const READ_PAGE_LIMIT = 65536;
const UNIT_TARGET = 2048;

export const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  );

export function boundedFields(value) {
  const result = Object.create(null);
  for (const [key, field] of Object.entries(value)) {
    if (jsonBytes(field) > READ_PAGE_LIMIT) {
      result[key + '_omitted'] = true;
      result.complete = false;
      result.reason = 'oversized_indivisible_content';
    } else result[key] = field;
  }
  return result;
}

// Split only for the response. Keep source text intact and use stable part
// boundaries so a continuation can change its page budget.
function jsonTextEnd(text, start, end) {
  let bytes = 2; // Quotes.
  for (let index = start; index < end;) {
    const code = text.codePointAt(index);
    if (code < 32) bytes += code >= 8 && code <= 13 && code !== 11 ? 2 : 6;
    else if (code < 128) bytes += code === 34 || code === 92 ? 2 : 1;
    else if (code < 2048) bytes += 2;
    else if (code > 0xffff) bytes += 4;
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3; // Lone surrogates escape.
    if (bytes > UNIT_TARGET) return index;
    index += code > 0xffff ? 2 : 1;
  }
  return end;
}

function* splitText(record, text, replace) {
  if (typeof text !== 'string' || !text.length) {
    yield record;
    return;
  }
  let part = 0;
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + UNIT_TARGET - 2);
    if (text.codePointAt(end - 1) > 0xffff) end--;
    if (jsonBytes(text.slice(start, end)) > UNIT_TARGET) end = jsonTextEnd(text, start, end);
    yield start === 0 && end === text.length
      ? record
      : { ...replace(text.slice(start, end)), part: ++part };
    start = end;
  }
}

// Shared message metadata is one complete unit, not copied into every text part.
// Nested calls are saved native records, not fabricated tool results.
function* splitMessage(record, message, replace) {
  const bodyKeys = ['content', 'summary', 'output', 'sections', 'toolsAdded', 'toolsRemoved'];
  const essentials = pick(message, [
    'role',
    'toolCallId',
    'toolName',
    'isError',
    'customType',
    'stopReason',
  ]);
  if (message.role === 'bashExecution') {
    // Repeat small execution facts, not arbitrary command/path metadata.
    Object.assign(essentials, pick(message, ['exitCode', 'cancelled', 'truncated']));
    for (const key of ['command', 'fullOutputPath'])
      if (typeof message[key] === 'string' && jsonBytes(message[key]) <= 256)
        essentials[key] = message[key];
  }
  const metadata = Object.fromEntries(
    Object.entries(message).filter(([key]) => !bodyKeys.includes(key)),
  );
  const nested = metadata.nestedCalls;
  const separateCalls =
    Array.isArray(nested?.calls) && nested.calls.length && jsonBytes(nested) > UNIT_TARGET;
  if (separateCalls) delete metadata.nestedCalls;
  if (
    !bodyKeys.some((key) => Object.hasOwn(message, key)) ||
    Object.keys(metadata).some((key) => !Object.hasOwn(essentials, key))
  )
    yield { ...replace(metadata), type: 'message_metadata' };
  if (separateCalls) {
    for (const [index, call] of nested.calls.entries())
      yield {
        ...replace(essentials),
        type: 'nested_call',
        source: { ...record.source, nested_call_index: index },
        nested_call: boundedFields(call),
        nested_calls_complete: nested.complete,
      };
  }
  const body = { ...essentials, ...pick(message, bodyKeys) };
  if (bodyKeys.some((key) => Object.hasOwn(body, key)))
    yield* splitMessageBody(replace(body), body, replace);
}

function* splitMessageBody(record, message, replace) {
  if (message.sections || message.toolsAdded || message.toolsRemoved) {
    const { sections, toolsAdded, toolsRemoved, content, ...rest } = message;
    for (const [name, value] of Object.entries(sections ?? {})) {
      const make = (text) => replace({ ...rest, sections: { [name]: text } }),
        base = make(value);
      if (typeof value === 'string') yield* splitText(base, value, make);
      else yield base;
    }
    for (const key of ['toolsAdded', 'toolsRemoved'])
      for (const tool of message[key] ?? []) {
        if (tool && typeof tool === 'object') {
          const { description, ...fields } = tool,
            reduced = boundedFields(fields),
            make = (text) =>
              replace({
                ...rest,
                [key]: [
                  { ...reduced, ...(description === undefined ? {} : { description: text }) },
                ],
              }),
            base = make(description);
          if (typeof description === 'string') yield* splitText(base, description, make);
          else yield base;
        } else yield replace({ ...rest, [key]: [tool] });
      }
    if (content) yield* splitMessage(replace({ ...rest, content }), { ...rest, content }, replace);
    return;
  }
  for (const key of ['summary', 'output'])
    if (typeof message[key] === 'string') {
      yield* splitText(record, message[key], (text) => replace({ ...message, [key]: text }));
      return;
    }
  if (typeof message.content === 'string') {
    yield* splitText(record, message.content, (text) => replace({ ...message, content: text }));
    return;
  }
  if (Array.isArray(message.content) && message.content.length) {
    for (const [index, block] of message.content.entries()) {
      const make = (block) => {
        const unit = replace({ ...message, content: [block] });
        return { ...unit, source: { ...unit.source, content_index: index } };
      };
      const base = make(block);
      const key = block.type === 'text' ? 'text' : block.type === 'thinking' ? 'thinking' : null;
      if (key) yield* splitText(base, block[key], (text) => make({ ...block, [key]: text }));
      else yield base;
    }
    return;
  }
  yield record;
}

function* pageParts(record) {
  if (jsonBytes(record) <= UNIT_TARGET) {
    yield record;
    return;
  }
  if (record.block && ['text', 'thinking'].includes(record.block.type)) {
    const { metadata, ...body } = record;
    if (metadata) {
      const { block, ...shared } = record;
      yield { ...shared, type: 'message_metadata' };
      if (metadata.stopReason !== undefined) body.metadata = { stopReason: metadata.stopReason };
    }
    const key = record.block.type;
    yield* splitText(body, body.block[key], (text) => ({
      ...body,
      block: { ...body.block, [key]: text },
    }));
  } else if (record.message) {
    yield* splitMessage(record, record.message, (message) => ({ ...record, message }));
  } else if (record.parts) {
    for (const part of record.parts) {
      const base = { ...record, parts: [part] };
      yield* splitMessage(base, part.message, (message) => ({
        ...base,
        parts: [{ source: part.source, message }],
      }));
    }
  } else yield record;
}

const metadataUnit = (unit) => ['message_metadata', 'nested_call'].includes(unit.type);

function fitMetadata(unit, fits) {
  const result = structuredClone(unit);
  const fields =
    result.type === 'nested_call'
      ? result.nested_call
      : (result.message ?? result.parts?.[0]?.message ?? result.metadata);
  if (!fields) return result;
  const essential = [
    'role',
    'toolCallId',
    'toolName',
    'isError',
    'id',
    'name',
    'status',
    'stopReason',
    'exitCode',
    'cancelled',
    'truncated',
  ];
  for (const key of Object.keys(fields)
    .filter((key) => !essential.includes(key))
    .sort((a, b) => jsonBytes(fields[b]) - jsonBytes(fields[a]))) {
    delete fields[key];
    (result.omitted_fields ??= []).push(key);
    result.complete = false;
    result.reason = 'oversized_indivisible_content';
    if (fits(result)) break;
  }
  return result;
}

function omittedUnit(unit) {
  return {
    ...pick(unit, [
      'type',
      'prompt_id',
      'source',
      'tool_id',
      'call_id',
      'pairing',
      'call_source',
      'part',
    ]),
    complete: false,
    reason: 'oversized_indivisible_content',
    content_omitted: true,
  };
}

export function smallLive(live, budget) {
  if (!live || jsonBytes(live) <= budget) return live;
  const result = { ...live, items: [], complete: false, omitted_by_capacity: true };
  const fits = (item) => jsonBytes({ ...result, items: [item, ...result.items] }) <= budget;
  for (const item of [...(live.items ?? [])].reverse()) {
    if (fits(item)) {
      result.items.unshift(item);
      continue;
    }
    const key = item.block?.type;
    if (['text', 'thinking'].includes(key) && typeof item.block[key] === 'string') {
      const text = item.block[key],
        make = (length) => {
          let start = text.length - length;
          if (text.codePointAt(start - 1) > 0xffff) start++;
          return { ...item, truncated: true, block: { ...item.block, [key]: text.slice(start) } };
        };
      let low = 0,
        high = text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits(make(mid))) low = mid;
        else high = mid - 1;
      }
      if (low && fits(make(low))) result.items.unshift(make(low));
    }
    break;
  }
  return jsonBytes(result) <= budget ? result : null;
}

// A frozen source may contain a single multi-megabyte message. Keep the next
// unread part for forward paging; replay from source for a different cursor.
const continuations = new WeakMap();

function* pageItems(units, rows, offset, part) {
  for (; offset < units.length; offset++) {
    if (rows) {
      yield { unit: rows.at(offset), nextOffset: offset + 1, nextPart: 0 };
      continue;
    }
    const parts = pageParts(units[offset]);
    let current = parts.next();
    for (let i = 0; i < part && !current.done; i++) current = parts.next();
    if (current.done) throw new Error('INVALID_CURSOR');
    while (!current.done) {
      const { value: unit } = current;
      current = parts.next();
      yield {
        unit,
        nextOffset: current.done ? offset + 1 : offset,
        nextPart: current.done ? 0 : ++part,
      };
    }
    part = 0;
  }
}

export function renderPreparedContextRead(
  snapshot,
  args,
  { cursor, encode, resultBudget, live, runtimeEvents, rows } = {},
) {
  const start = cursor?.offset ?? 0,
    firstPart = cursor?.part ?? 0,
    max = args.max_bytes ?? DEFAULT_READ_BYTES;
  const units = rows ?? snapshot.units;
  if (start < 0 || start > units.length) throw new Error('INVALID_CURSOR');
  const base = {
    session_id: snapshot.session_id,
    view: snapshot.view ?? 'session',
    ...(snapshot.observation ? { observation: snapshot.observation } : {}),
    ...(snapshot.reader ? { reader: snapshot.reader } : {}),
    source: snapshot.source ?? 'session_projection',
    leaf_id: snapshot.leaf_id,
    selection: snapshot.selection,
    ...(snapshot.presentation ? { presentation: snapshot.presentation } : {}),
    ...(snapshot.query ? { query: snapshot.query, matches: units.length } : {}),
    ...(snapshot.expanded_refs ? { expanded_refs: snapshot.expanded_refs } : {}),
    ...(snapshot.history ? { history: snapshot.history } : {}),
    live: cursor || args.leaf_id !== undefined ? null : smallLive(live, Math.floor(max / 4)),
    ...(snapshot.view !== 'runtime' &&
    snapshot.view !== 'adapted' &&
    !cursor &&
    args.leaf_id === undefined &&
    runtimeEvents
      ? { runtime_events: boundRuntimeEvents(runtimeEvents, Math.min(4096, Math.floor(max / 4))) }
      : {}),
  };
  const page = (items, offset, part = 0) => ({
    ...base,
    items,
    next_cursor: offset < units.length ? encode(offset, part) : null,
    omissions: {
      selection: snapshot.omissions,
      capacity: { remaining_units: units.length - offset, previous_units: start },
    },
  });
  const maxBytes = Math.min(max, resultBudget?.maxBytes ?? max);
  const maxWireBytes = resultBudget?.maxWireBytes ?? Infinity;
  const size = (value) => resultSize(value, Boolean(resultBudget));
  const fits = ({ bytes, wireBytes }) => bytes <= maxBytes && wireBytes <= maxWireBytes;
  const emptyArray = size([]);
  const items = [];
  let itemBytes = 0;
  let itemWireBytes = 0;
  let offset = start;
  let part = firstPart;
  const previous = continuations.get(snapshot);
  const resume = previous?.offset === start && previous.part === firstPart;
  const iterator = resume ? previous.iterator : pageItems(units, rows, start, firstPart);
  let current = resume ? previous.current : iterator.next();
  continuations.delete(snapshot);
  while (!current.done) {
    let { unit, nextOffset, nextPart } = current.value;
    let frame = size(page([], nextOffset, nextPart));
    const comma = items.length ? 1 : 0;
    // JSON array items add only their serialized bytes and a comma. The
    // escaped text copy adds the same comma and the escaped item bytes.
    const unitSize = (candidate) => {
      const { bytes, wireBytes } = size([candidate]);
      return {
        bytes: bytes - emptyArray.bytes + comma,
        wireBytes: wireBytes - emptyArray.wireBytes + comma * 2,
      };
    };
    const pageWith = (cost) => ({
      bytes: frame.bytes + itemBytes + cost.bytes,
      wireBytes: frame.wireBytes + itemWireBytes + cost.wireBytes,
    });
    let cost = unitSize(unit);
    if (!items.length && !fits(pageWith(cost))) {
      base.live = smallLive(base.live, 256);
      delete base.runtime_events;
      frame = size(page([], nextOffset, nextPart));
      if (!fits(pageWith(cost))) {
        base.live = null;
        frame = size(page([], nextOffset, nextPart));
      }
    }
    if (!items.length && !fits(pageWith(cost))) {
      const fitsUnit = (value) => fits(pageWith(unitSize(value)));
      if (metadataUnit(unit)) unit = fitMetadata(unit, fitsUnit);
      else if (rows) unit = fitNavigationRow(unit, fitsUnit);
      cost = unitSize(unit);
    }
    if (frame.bytes + cost.bytes > READ_PAGE_LIMIT) {
      const maximum = { ...page([unit], nextOffset, nextPart), live: null };
      delete maximum.runtime_events;
      if (jsonBytes(maximum) > READ_PAGE_LIMIT) {
        if (items.length && metadataUnit(unit)) break;
        unit = omittedUnit(unit);
        cost = unitSize(unit);
      }
    }
    const measured = pageWith(cost);
    if (!fits(measured)) {
      if (items.length) break;
      if (measured.bytes <= max && resultBudget) throw new Error('BATCH_QUERY_BUDGET_TOO_SMALL');
      const error = new Error('READ_BUDGET_TOO_SMALL');
      error.minimum_max_bytes = measured.bytes;
      throw error;
    }
    items.push(unit);
    itemBytes += cost.bytes;
    itemWireBytes += cost.wireBytes;
    offset = nextOffset;
    part = nextPart;
    current = iterator.next();
  }
  const result = page(items, offset, part);
  if (!fits(size(result))) throw new Error('READ_BUDGET_TOO_SMALL');
  if (!rows && !current.done) continuations.set(snapshot, { offset, part, iterator, current });
  return structuredClone(result);
}
