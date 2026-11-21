import { DEFAULT_READ_BYTES } from './read-schema.mjs';
import {
  jsonBytes,
  largestFittingSize,
  payloadSize,
  TOOL_FRAME_BYTES,
} from '../mcp/response-budget.mjs';
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
function jsonTextEnd(text, start) {
  let bytes = 2; // Quotes.
  for (let index = start; index < text.length;) {
    const code = text.codePointAt(index);
    if (code < 32) bytes += code >= 8 && code <= 13 && code !== 11 ? 2 : 6;
    else if (code < 128) bytes += code === 34 || code === 92 ? 2 : 1;
    else if (code < 2048) bytes += 2;
    else if (code > 0xffff) bytes += 4;
    else bytes += code >= 0xd800 && code <= 0xdfff ? 6 : 3; // Lone surrogates escape.
    if (bytes > UNIT_TARGET) return index;
    index += code > 0xffff ? 2 : 1;
  }
  return text.length;
}

// Every splittable field uses the same stable offsets. The emitter supplies
// only the surrounding native wire shape (block, message or summary part).
function* fragments(text, emit) {
  if (typeof text !== 'string' || !text) {
    yield emit(text);
    return;
  }
  for (let index = 0, part = 0; index < text.length;) {
    const end = jsonTextEnd(text, index);
    const unit = emit(text.slice(index, end));
    yield index || end < text.length ? { ...unit, part: ++part } : unit;
    index = end;
  }
}

const bodyFields = ['content', 'summary', 'output', 'sections', 'toolsAdded', 'toolsRemoved'];
const messageIdentity = ['role', 'toolCallId', 'toolName', 'isError', 'customType', 'stopReason'];
const commandStatus = ['exitCode', 'cancelled', 'truncated'];
const essentialMetadata = new Set([
  ...messageIdentity.filter((key) => key !== 'customType'),
  ...commandStatus,
  'id',
  'name',
  'status',
]);
const isText = (block) => block.type === 'text' || block.type === 'thinking';

function* blockParts(block, emit) {
  const field = block.type;
  if (isText(block)) yield* fragments(block[field], (text) => emit({ ...block, [field]: text }));
  else yield emit(block);
}

function* messageParts(message, emit) {
  const { sections, toolsAdded, toolsRemoved, content } = message;
  const body = pick(message, bodyFields);
  const meta = Object.fromEntries(
    Object.entries(message).filter(([key]) => !bodyFields.includes(key)),
  );
  const identity = pick(message, messageIdentity);
  if (message.role === 'bashExecution') {
    Object.assign(identity, pick(message, commandStatus));
    for (const key of ['command', 'fullOutputPath'])
      if (typeof meta[key] === 'string' && jsonBytes(meta[key]) <= 256) identity[key] = meta[key];
  }
  const nested = meta.nestedCalls;
  const separate =
    Array.isArray(nested?.calls) && nested.calls.length && jsonBytes(nested) > UNIT_TARGET;
  if (separate) delete meta.nestedCalls;
  if (!Object.keys(body).length || Object.keys(meta).some((key) => !Object.hasOwn(identity, key)))
    yield { ...emit(meta), type: 'message_metadata' };
  if (separate)
    for (const [index, call] of nested.calls.entries()) {
      const unit = emit(identity);
      yield {
        ...unit,
        type: 'nested_call',
        source: { ...unit.source, nested_call_index: index },
        nested_call: boundedFields(call),
        nested_calls_complete: nested.complete,
      };
    }
  if (!Object.keys(body).length) return;
  if (sections || toolsAdded || toolsRemoved) {
    const rest = { ...identity, ...pick(body, ['summary', 'output']) };
    for (const [name, value] of Object.entries(sections ?? {}))
      yield* fragments(value, (text) => emit({ ...rest, sections: { [name]: text } }));
    for (const key of ['toolsAdded', 'toolsRemoved'])
      for (const tool of body[key] ?? []) {
        if (!tool || typeof tool !== 'object') yield emit({ ...rest, [key]: [tool] });
        else {
          const { description, ...fields } = tool;
          const safe = boundedFields(fields);
          yield* fragments(description, (text) =>
            emit({
              ...rest,
              [key]: [{ ...safe, ...(text === undefined ? {} : { description: text }) }],
            }),
          );
        }
      }
    if (!content) return;
    delete body.sections;
    delete body.toolsAdded;
    delete body.toolsRemoved;
  }
  const record = { ...identity, ...body };
  const field = ['summary', 'output', 'content'].find((key) => typeof record[key] === 'string');
  if (field) yield* fragments(record[field], (text) => emit({ ...record, [field]: text }));
  else if (Array.isArray(content) && content.length)
    for (const [content_index, block] of content.entries()) {
      yield* blockParts(block, (value) => {
        const unit = emit({ ...record, content: [value] });
        return { ...unit, source: { ...unit.source, content_index } };
      });
    }
  else yield emit(record);
}

function* pageParts(record) {
  if (jsonBytes(record) <= UNIT_TARGET) yield record;
  else if (record.block && isText(record.block)) {
    const { block, metadata, ...base } = record;
    if (metadata) {
      yield { ...base, metadata, type: 'message_metadata' };
      if (metadata.stopReason !== undefined) base.metadata = { stopReason: metadata.stopReason };
    }
    yield* blockParts(block, (part) => ({ ...base, block: part }));
  } else if (record.message)
    yield* messageParts(record.message, (message) => ({ ...record, message }));
  else if (record.parts)
    for (const { source, message } of record.parts)
      yield* messageParts(message, (part) => ({ ...record, parts: [{ source, message: part }] }));
  else yield record;
}

const metadataUnit = (unit) => ['message_metadata', 'nested_call'].includes(unit.type);

function fitMetadata(unit, fits) {
  const result = structuredClone(unit);
  const fields =
    result.type === 'nested_call'
      ? result.nested_call
      : (result.message ?? result.parts?.[0]?.message ?? result.metadata);
  if (!fields) return result;
  const removable = Object.keys(fields)
    .filter((key) => !essentialMetadata.has(key))
    .map((key) => [key, jsonBytes(fields[key])])
    .sort((a, b) => b[1] - a[1]);
  for (const [key] of removable) {
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
      const length = largestFittingSize(text.length, (size) => fits(make(size)));
      if (length) result.items.unshift(make(length));
    }
    break;
  }
  return jsonBytes(result) <= budget ? result : null;
}

// A frozen source may contain a single multi-megabyte message. Keep the next
// unread part for forward paging; replay from source for a different cursor.
const continuations = new WeakMap();

function* pageItems(units, preview, offset, part) {
  for (; offset < units.length; offset++) {
    const unit = units.at(offset);
    const parts = preview ? [unit].values() : pageParts(unit);
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
  const required = {
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
    ...(!cursor && snapshot.commands?.length ? { commands: snapshot.commands } : {}),
    live: null,
  };
  let base = {
    ...required,
    live: cursor || args.leaf_id !== undefined ? null : smallLive(live, Math.floor(max / 4)),
    ...(snapshot.view !== 'runtime' &&
    snapshot.view !== 'adapted' &&
    !cursor &&
    args.leaf_id === undefined &&
    runtimeEvents
      ? { runtime_events: boundRuntimeEvents(runtimeEvents, Math.min(4096, Math.floor(max / 4))) }
      : {}),
  };
  const paging = (offset, part) => ({
    next_cursor: offset < units.length ? encode(offset, part) : null,
    omissions: {
      selection: snapshot.omissions,
      capacity: { remaining_units: units.length - offset, previous_units: start },
    },
  });
  const maxBytes = Math.min(max, resultBudget?.maxBytes ?? max);
  // Work in payload bytes throughout. Charge the MCP text/structured wrapper once.
  const maxWireBytes = (resultBudget?.maxWireBytes ?? Infinity) - TOOL_FRAME_BYTES;
  const size = (value) => payloadSize(value, Boolean(resultBudget));
  const fits = ({ bytes, wireBytes }) => bytes <= maxBytes && wireBytes <= maxWireBytes;
  const requiredSize = size(required);
  let baseSize = size(base);
  const items = [];
  let bytes = 0,
    wireBytes = 0;
  let offset = start,
    part = firstPart;
  const previous = continuations.get(snapshot);
  const resume = previous?.offset === start && previous.part === firstPart;
  const iterator = resume ? previous.iterator : pageItems(units, Boolean(rows), start, firstPart);
  let current = resume ? previous.current : iterator.next();
  continuations.delete(snapshot);
  while (!current.done) {
    let { unit, nextOffset, nextPart } = current.value;
    const tail = size({ items: [], ...paging(nextOffset, nextPart) });
    const comma = items.length ? 1 : 0;
    // Join two JSON objects (-1 byte) and separate consecutive items (+1).
    const punctuation = comma - 1;
    const pageWith = (cost) => ({
      bytes: baseSize.bytes + tail.bytes + bytes + cost.bytes + punctuation,
      wireBytes: baseSize.wireBytes + tail.wireBytes + wireBytes + cost.wireBytes + 2 * punctuation,
    });
    let cost = size(unit);
    if (!items.length && !fits(pageWith(cost))) {
      base = { ...required, live: smallLive(base.live, 256) };
      baseSize = size(base);
      if (!fits(pageWith(cost))) {
        base = required;
        baseSize = requiredSize;
        if (!fits(pageWith(cost))) {
          const fitsUnit = (value) => fits(pageWith(size(value)));
          if (metadataUnit(unit)) unit = fitMetadata(unit, fitsUnit);
          else if (rows) unit = fitNavigationRow(unit, fitsUnit);
          cost = size(unit);
        }
      }
    }
    if (requiredSize.bytes + tail.bytes - 1 + cost.bytes > READ_PAGE_LIMIT) {
      if (items.length && metadataUnit(unit)) break;
      unit = omittedUnit(unit);
      cost = size(unit);
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
    bytes += cost.bytes + comma;
    wireBytes += cost.wireBytes + 2 * comma;
    offset = nextOffset;
    part = nextPart;
    current = iterator.next();
  }
  const result = { ...base, items, ...paging(offset, part) };
  if (!fits(size(result))) throw new Error('READ_BUDGET_TOO_SMALL');
  if (!rows && !current.done) continuations.set(snapshot, { offset, part, iterator, current });
  return structuredClone(result);
}
