import { createHash } from 'node:crypto';
import { buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { readSchema, contextSelection } from './read-schema.mjs';

const FORMAT = 'context_timeline';
const VERSION = 1;
const bytes = (value) => Buffer.byteLength(JSON.stringify(value), 'utf8');
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('base64url');
const boundary = (text, at) =>
  !(
    at > 0 &&
    at < text.length &&
    text.charCodeAt(at - 1) >= 0xd800 &&
    text.charCodeAt(at - 1) <= 0xdbff &&
    text.charCodeAt(at) >= 0xdc00 &&
    text.charCodeAt(at) <= 0xdfff
  );
const encodeCursor = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(value) {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      cursor?.kind !== FORMAT ||
      cursor.version !== VERSION ||
      typeof cursor.session !== 'string' ||
      typeof cursor.selection !== 'string' ||
      typeof cursor.projection !== 'string' ||
      !(cursor.leaf_id === null || typeof cursor.leaf_id === 'string') ||
      !Number.isSafeInteger(cursor.index) ||
      cursor.index < 0 ||
      !Number.isSafeInteger(cursor.offset) ||
      cursor.offset < 1
    )
      throw new Error();
    return cursor;
  } catch {
    throw new Error('INVALID_CURSOR');
  }
}
const take = (values, n, reverse = false) =>
  n === -1 ? values : n === 0 ? [] : reverse ? values.slice(-n) : values.slice(0, n);
const ends = (values, n) =>
  new Set(n === -1 ? values : [...take(values, n), ...take(values, n, true)]);

/**
 * The projection, not timestamps or raw-file order, is the ordering authority.
 * Retain hidden user entries as empty boundaries before flattening messages.
 */
function timeline(projection) {
  const records = [],
    prompts = [],
    summaryParts = [];
  let prompt = null,
    summaryRecord;
  function add(type, source, extra = {}, owner = prompt) {
    const record = {
      id: `${source.entry_id}:${source.message_index ?? 'boundary'}:${source.block_index ?? 'message'}:${type}`,
      type,
      prompt_id: owner,
      source,
      ...extra,
    };
    records.push(record);
    return record;
  }
  function emptyPrompt(source, reason) {
    prompt = `empty:${source.entry_id}:${reason}`;
    prompts.push(prompt);
    add('prompt', source, { synthetic: true, reason, message: { role: 'user', content: '' } });
  }
  function requirePrompt(source) {
    if (prompt === null) {
      const { message_index, block_index, ...entrySource } = source;
      emptyPrompt(entrySource, 'context_prefix');
    }
  }
  for (const [entryIndex, projected] of projection.entries.entries()) {
    const { sourceEntry: entry, messages } = projected;
    const base = { entry_id: entry.id, entry_index: entryIndex };
    if (entry.type === 'message' && entry.message.role === 'user' && !messages.length) {
      emptyPrompt(base, 'hidden_user');
    }
    for (const [messageIndex, message] of messages.entries()) {
      const source = { ...base, message_index: messageIndex };
      if (message.role === 'user') {
        prompt = entry.id;
        prompts.push(prompt);
        add('prompt', source, { synthetic: false, message });
      } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
        if (!summaryRecord) summaryRecord = add('summary', source, { parts: summaryParts }, null);
        summaryParts.push({ source, message });
      } else if (message.role === 'system') {
        add('system', source, { message }, null);
      } else if (message.role === 'assistant') {
        requirePrompt(source);
        const { content, ...metadata } = message;
        if (Array.isArray(content) && content.length) {
          for (const [blockIndex, block] of content.entries()) {
            const type =
              block.type === 'text'
                ? 'text'
                : block.type === 'thinking'
                  ? 'thinking'
                  : block.type === 'toolCall'
                    ? 'tool_call'
                    : 'native';
            add(type, { ...source, block_index: blockIndex }, { block, metadata });
          }
        } else add('native', source, { message });
      } else if (message.role === 'toolResult') {
        requirePrompt(source);
        add('tool_result', source, { message });
      } else if (message.role === 'bashExecution') {
        add('command', source, { message, in_model_context: !message.excludeFromContext });
      } else {
        // Custom, image-bearing and future augmented roles remain native data.
        add(message.role === 'custom' ? 'custom' : 'native', source, { message });
      }
    }
  }
  // Pair before selection; a steering boundary must not steal a prior result.
  // A repeated call ID resolves to the latest preceding call without a result.
  const open = new Map(),
    units = new Map();
  for (const record of records) {
    if (record.type === 'tool_call') {
      record.tool_id = record.id;
      record.call_id = record.block.id;
      record.pairing = 'unresolved';
      const stack = open.get(record.call_id) ?? [];
      stack.push(record);
      open.set(record.call_id, stack);
      units.set(record.tool_id, { prompt_id: record.prompt_id, records: [record] });
    } else if (record.type === 'tool_result') {
      const call = open.get(record.message.toolCallId)?.pop();
      record.call_id = record.message.toolCallId;
      record.tool_id = call?.tool_id ?? record.id;
      record.pairing = call ? 'paired' : 'orphan_result';
      if (call) {
        record.prompt_id = call.prompt_id;
        record.call_source = call.source;
        call.pairing = 'paired';
        units.get(record.tool_id).records.push(record);
      } else units.set(record.tool_id, { prompt_id: record.prompt_id, records: [record] });
    }
  }
  return { records, prompts, units };
}

function selectTimeline(projected, selection) {
  const { records, prompts, units } = timeline(projected);
  const selectedPrompts = new Set([
    ...take(prompts, selection.earliest_prompts),
    ...take(prompts, selection.recent_prompts, true),
  ]);
  const chosen = new Set();
  const totals = {
    summary: records.some((r) => r.type === 'summary') ? 1 : 0,
    prompts: prompts.length,
    text: 0,
    thinking: 0,
    tools: units.size,
    commands: 0,
  };
  const included = {
    summary: 0,
    prompts: selectedPrompts.size,
    text: 0,
    thinking: 0,
    tools: 0,
    commands: 0,
  };
  for (const type of ['text', 'thinking']) {
    const groups = new Map();
    for (const record of records)
      if (record.type === type) {
        totals[type]++;
        const group = groups.get(record.prompt_id) ?? [];
        group.push(record);
        groups.set(record.prompt_id, group);
      }
    for (const [id, group] of groups)
      if (selectedPrompts.has(id)) {
        for (const record of ends(group, selection[type])) {
          chosen.add(record);
          included[type]++;
        }
      }
  }
  const toolGroups = new Map();
  for (const unit of units.values()) {
    const group = toolGroups.get(unit.prompt_id) ?? [];
    group.push(unit);
    toolGroups.set(unit.prompt_id, group);
  }
  for (const [id, group] of toolGroups)
    if (selectedPrompts.has(id)) {
      for (const unit of ends(group, selection.tools)) {
        included.tools++;
        for (const record of unit.records) chosen.add(record);
      }
    }
  const commands = records.filter((r) => r.type === 'command');
  totals.commands = commands.length;
  for (const record of take(commands, selection.commands, true)) {
    chosen.add(record);
    included.commands++;
  }
  for (const record of records) {
    if (record.type === 'prompt' && selectedPrompts.has(record.prompt_id)) chosen.add(record);
    if (record.type === 'summary' && selection.summary !== 0) {
      chosen.add(record);
      included.summary = 1;
    }
    // Seven selectors do not describe system/custom/unknown native content.
    // Preserve it rather than silently redefining "full" as text-only.
    if (['system', 'custom', 'native'].includes(record.type)) {
      if (
        record.type !== 'native' ||
        (!record.metadata && record.message?.role !== 'assistant') ||
        selectedPrompts.has(record.prompt_id)
      )
        chosen.add(record);
    }
  }
  return {
    records: records
      .filter((r) => chosen.has(r))
      .map((r, index) => ({ ...r, record_index: index })),
    latestPrompt: prompts.at(-1) ?? null,
    latestPromptSelected: selectedPrompts.has(prompts.at(-1)),
    omissions: Object.fromEntries(
      Object.keys(totals).map((key) => [key, totals[key] - included[key]]),
    ),
  };
}

// Live output is an explicitly transient preview, never part of a historical
// cursor. Bound its share so an enormous partial answer cannot starve history.
function livePreview(live, selection, selected, maxBytes) {
  if (!live) return null;
  const base = {
    source: String(live.source ?? 'native_message_events').slice(0, 100),
    available: live.available !== false,
    observed_at: typeof live.observed_at === 'string' ? live.observed_at.slice(0, 100) : null,
    transient: true,
    prompt_id: selected.latestPrompt,
  };
  if (live.available === false)
    return { ...base, reason: String(live.reason ?? 'unavailable').slice(0, 200) };
  if (selected.latestPrompt !== null && !selected.latestPromptSelected) {
    return { ...base, omitted_by_selection: true };
  }
  const message = live.message;
  if (message === null) return { ...base, format: 'message', message: null, complete: true };
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content))
    return { ...base, available: false, reason: 'invalid_live_message' };
  const chosen = new Set(),
    omissions = { text: 0, thinking: 0, tools: 0 };
  for (const [type, key] of [
    ['text', 'text'],
    ['thinking', 'thinking'],
    ['toolCall', 'tools'],
  ]) {
    const group = message.content
      .map((block, index) => ({ block, index }))
      .filter((item) => item.block.type === type);
    const keep = ends(group, selection[key]);
    omissions[key] = group.length - keep.size;
    for (const item of keep) chosen.add(item.index);
  }
  message.content.forEach((block, index) => {
    if (!['text', 'thinking', 'toolCall'].includes(block.type)) chosen.add(index);
  });
  const indices = [...chosen].sort((a, b) => a - b);
  const selectedMessage = { ...message, content: indices.map((index) => message.content[index]) };
  const native = {
    ...base,
    format: 'message',
    message: selectedMessage,
    block_indices: indices,
    selection_omissions: omissions,
    complete: live.complete !== false && live.truncated !== true,
    ...(live.truncated === true ? { upstream_truncated: true } : {}),
    ...(live.omitted_units === undefined ? {} : { upstream_omitted_units: live.omitted_units }),
  };
  if (bytes(native) <= maxBytes) return native;
  const encoded = JSON.stringify(selectedMessage);
  const make = (end) => ({
    ...base,
    format: 'json_fragment',
    offset_unit: 'utf16_code_units',
    offset: 0,
    total_units: encoded.length,
    json_fragment: encoded.slice(0, end),
    complete: false,
    selection_omissions: omissions,
    omitted_units: encoded.length - end,
    ...(live.complete === false || live.truncated === true ? { upstream_complete: false } : {}),
  });
  let low = 0,
    high = encoded.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      end = boundary(encoded, mid) ? mid : mid - 1;
    if (bytes(make(end)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  const end = boundary(encoded, low) ? low : low - 1;
  return bytes(make(end)) <= maxBytes
    ? make(end)
    : { ...base, complete: false, omitted_by_capacity: true };
}

function page(base, items, next) {
  const first = items[0],
    last = items.at(-1);
  const fragmented = items.some((item) => item.type === 'fragment');
  return {
    ...base,
    items,
    next_cursor: next,
    omissions: {
      selection: base.omissions.selection,
      capacity: {
        records_before: first?.record_index ?? 0,
        records_after: last ? base.total_items - last.record_index - 1 : 0,
        fragmented,
      },
    },
  };
}
function nextAt(binding, index, offset) {
  return index < 0 ? null : encodeCursor({ ...binding, index, offset });
}
function previous(binding, record) {
  return record.record_index === 0
    ? null
    : // offset = 0 is never a real record boundary. This sentinel resolves the
      // preceding complete record without storing its serialized size in a page.
      encodeCursor({ ...binding, index: record.record_index - 1, offset: Number.MAX_SAFE_INTEGER });
}
function fragment(record, encoded, start, end) {
  return {
    id: record.id,
    type: 'fragment',
    record_type: record.type,
    prompt_id: record.prompt_id,
    source: record.source,
    record_index: record.record_index,
    encoding: 'json',
    offset_unit: 'utf16_code_units',
    offset: start,
    total_units: encoded.length,
    json_fragment: encoded.slice(start, end),
  };
}
function fitSuffix(record, encoded, end, budget, build) {
  let low = 0,
    high = end;
  const make = (length) => {
    let start = end - length;
    if (!boundary(encoded, start)) start++;
    return { start, item: fragment(record, encoded, start, end) };
  };
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      candidate = make(mid);
    if (bytes(build(candidate.item, candidate.start)) <= budget) low = mid;
    else high = mid - 1;
  }
  return make(low);
}

/**
 * Synchronous pure renderer shared by saved snapshots and cooperative owners.
 * Authorization and snapshot acquisition belong to Bridge/runtime, not here.
 */
export function renderContextRead(data, rawArgs) {
  const parsed = readSchema.safeParse(rawArgs);
  if (!parsed.success) throw new Error('INVALID_READ_ARGUMENTS');
  const args = parsed.data,
    selection = contextSelection(args);
  const cursor = args.cursor ? decodeCursor(args.cursor) : null;
  const session = digest([args.session_id, data.header?.id ?? null]);
  const selectionHash = digest(selection);
  if (
    cursor &&
    (cursor.session !== session ||
      cursor.selection !== selectionHash ||
      (args.leaf_id !== undefined && args.leaf_id !== cursor.leaf_id))
  )
    throw new Error('STALE_CURSOR');
  const leaf = cursor
    ? cursor.leaf_id
    : args.leaf_id !== undefined
      ? args.leaf_id
      : data.leafId === undefined
        ? (data.entries.at(-1)?.id ?? null)
        : data.leafId;
  if (leaf !== null && !data.entries.some((e) => e.id === leaf))
    throw new Error(cursor ? 'STALE_CURSOR' : 'ENTRY_NOT_FOUND');
  const selected = selectTimeline(buildSessionProjection(data.entries, leaf), selection);
  const projection = digest(selected.records);
  if (cursor && cursor.projection !== projection) throw new Error('STALE_CURSOR');
  const binding = {
    kind: FORMAT,
    version: VERSION,
    session,
    selection: selectionHash,
    projection,
    leaf_id: leaf,
  };
  const budget = args.max_bytes ?? 24000;
  const live =
    !cursor && args.leaf_id === undefined
      ? livePreview(
          data.live ?? {
            source: 'snapshot',
            available: false,
            reason: 'native_events_unavailable',
          },
          selection,
          selected,
          Math.min(4096, Math.floor(budget / 4)),
        )
      : null;
  const base = {
    format: FORMAT,
    version: VERSION,
    session_id: args.session_id,
    leaf_id: leaf,
    context_kind: 'pi_session_projection_not_final_provider_payload',
    selection,
    snapshot: projection,
    snapshot_session: session,
    total_items: selected.records.length,
    order: 'chronological',
    continuation: 'backward',
    live,
    omissions: { selection: selected.omissions },
  };
  const items = [];
  let index = cursor?.index ?? selected.records.length - 1;
  if (index >= selected.records.length) throw new Error('INVALID_CURSOR');
  if (index < 0) return page(base, [], null);
  let end = cursor?.offset ?? Number.MAX_SAFE_INTEGER;
  while (index >= 0) {
    const record = selected.records[index],
      encoded = JSON.stringify(record);
    if (end === Number.MAX_SAFE_INTEGER) end = encoded.length;
    if (end > encoded.length || !boundary(encoded, end)) throw new Error('INVALID_CURSOR');
    const next = previous(binding, record);
    const candidate = end === encoded.length ? record : fragment(record, encoded, 0, end);
    if (bytes(page(base, [candidate, ...items], next)) <= budget) {
      items.unshift(candidate);
      index--;
      end = Number.MAX_SAFE_INTEGER;
      continue;
    }
    if (items.length) {
      end = Number.MAX_SAFE_INTEGER;
      break;
    }
    const build = (item, start) => page(base, [item], start ? nextAt(binding, index, start) : next);
    const fitted = fitSuffix(record, encoded, end, budget, build);
    if (!fitted.item.json_fragment.length) throw new Error('READ_BUDGET_TOO_SMALL');
    return build(fitted.item, fitted.start);
  }
  const next = index < 0 ? null : nextAt(binding, index, end);
  return page(base, items, next);
}

/** Reject old owners that silently ignored the new public read contract. */
export function assertContextReadResponse(result, rawArgs) {
  const args = readSchema.parse(rawArgs),
    reject = () => {
      throw new Error('OWNER_READ_REFRESH_REQUIRED');
    };
  if (
    !result ||
    result.format !== FORMAT ||
    result.version !== VERSION ||
    result.session_id !== args.session_id ||
    digest(result.selection) !== digest(contextSelection(args)) ||
    result.context_kind !== 'pi_session_projection_not_final_provider_payload' ||
    !(result.leaf_id === null || typeof result.leaf_id === 'string') ||
    (args.leaf_id !== undefined && args.leaf_id !== result.leaf_id) ||
    typeof result.snapshot !== 'string' ||
    typeof result.snapshot_session !== 'string' ||
    !Number.isSafeInteger(result.total_items) ||
    result.total_items < 0 ||
    result.order !== 'chronological' ||
    result.continuation !== 'backward' ||
    !Array.isArray(result.items) ||
    !result.omissions?.selection ||
    !result.omissions?.capacity ||
    bytes(result) > (args.max_bytes ?? 24000) ||
    !(result.next_cursor === null || typeof result.next_cursor === 'string')
  )
    reject();
  let last = -1;
  for (const item of result.items) {
    if (
      !item ||
      typeof item.id !== 'string' ||
      typeof item.type !== 'string' ||
      !(item.prompt_id === null || typeof item.prompt_id === 'string') ||
      typeof item.source?.entry_id !== 'string' ||
      !Number.isSafeInteger(item.record_index) ||
      item.record_index <= last ||
      item.record_index >= result.total_items
    )
      reject();
    if (
      item.type === 'fragment' &&
      (typeof item.json_fragment !== 'string' ||
        !item.json_fragment.length ||
        !Number.isSafeInteger(item.offset) ||
        item.offset < 0 ||
        !Number.isSafeInteger(item.total_units) ||
        item.total_units < item.offset + item.json_fragment.length ||
        item.offset_unit !== 'utf16_code_units' ||
        item.encoding !== 'json')
    )
      reject();
    last = item.record_index;
  }
  const incoming = args.cursor ? decodeCursor(args.cursor) : null;
  if (
    incoming &&
    (incoming.leaf_id !== result.leaf_id ||
      incoming.projection !== result.snapshot ||
      incoming.session !== result.snapshot_session ||
      incoming.selection !== digest(result.selection))
  )
    reject();
  if (result.next_cursor !== null) {
    const next = decodeCursor(result.next_cursor),
      first = result.items[0];
    if (
      !first ||
      next.leaf_id !== result.leaf_id ||
      next.projection !== result.snapshot ||
      next.selection !== digest(result.selection) ||
      next.session !== result.snapshot_session ||
      (incoming && next.session !== incoming.session) ||
      (first.type === 'fragment' && first.offset > 0
        ? next.index !== first.record_index || next.offset !== first.offset
        : next.index !== first.record_index - 1 || next.offset !== Number.MAX_SAFE_INTEGER)
    )
      reject();
  }
  if (result.total_items && !result.items.length) reject();
  const first = result.items[0],
    tail = result.items.at(-1),
    capacity = result.omissions.capacity;
  const omissionKeys = ['summary', 'prompts', 'text', 'thinking', 'tools', 'commands'];
  if (omissionKeys.some((key) => !Object.hasOwn(result.omissions.selection, key))) reject();
  if (
    capacity.records_before !== (first?.record_index ?? 0) ||
    capacity.records_after !== (tail ? result.total_items - tail.record_index - 1 : 0) ||
    capacity.fragmented !== result.items.some((item) => item.type === 'fragment') ||
    Object.values(result.omissions.selection).some(
      (value) => !Number.isSafeInteger(value) || value < 0,
    )
  )
    reject();
  if (
    result.next_cursor === null &&
    first &&
    (first.record_index !== 0 || (first.type === 'fragment' && first.offset !== 0))
  )
    reject();
  if (incoming && tail) {
    if (tail.record_index !== incoming.index) reject();
    if (
      incoming.offset !== Number.MAX_SAFE_INTEGER &&
      (tail.type !== 'fragment' || tail.offset + tail.json_fragment.length !== incoming.offset)
    )
      reject();
  }
  if ((args.cursor || args.leaf_id !== undefined) && result.live !== null) reject();
  if (result.live !== null) {
    const live = result.live;
    if (
      !live ||
      typeof live !== 'object' ||
      typeof live.available !== 'boolean' ||
      typeof live.source !== 'string' ||
      live.transient !== true ||
      !(live.prompt_id === null || typeof live.prompt_id === 'string')
    )
      reject();
    if (live.available && !live.omitted_by_capacity && !live.omitted_by_selection) {
      if (live.format === 'message') {
        if (live.message !== null && live.message?.role !== 'assistant') reject();
      } else if (live.format === 'json_fragment') {
        if (
          typeof live.json_fragment !== 'string' ||
          live.offset !== 0 ||
          !Number.isSafeInteger(live.total_units) ||
          live.total_units < live.json_fragment.length ||
          live.offset_unit !== 'utf16_code_units' ||
          live.complete !== false
        )
          reject();
      } else reject();
    }
  }
}

/** Resize a captured authorized page without reacquiring mutable session data. */
export function rebudgetContextRead(result, args, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) return null;
  if (bytes(result) <= maxBytes) return result;
  if (result?.format !== FORMAT || !Array.isArray(result.items)) return null;
  const binding = {
    kind: FORMAT,
    version: VERSION,
    session: result.snapshot_session,
    selection: digest(result.selection),
    projection: result.snapshot,
    leaf_id: result.leaf_id,
  };
  const base = { ...result };
  delete base.items;
  delete base.next_cursor;
  // A moving live preview has no historical continuation. Drop its payload
  // before reducing captured history and make that capacity omission explicit.
  if (base.live?.available && bytes(base.live) > Math.floor(maxBytes / 4)) {
    const { source, observed_at, transient, prompt_id } = base.live;
    base.live = {
      source,
      available: true,
      observed_at,
      transient,
      prompt_id,
      complete: false,
      omitted_by_capacity: true,
    };
  }
  const items = [];
  if (!result.items.length) {
    const reduced = page(base, [], result.next_cursor);
    return bytes(reduced) <= maxBytes ? reduced : null;
  }
  for (let i = result.items.length - 1; i >= 0; i--) {
    const record = result.items[i],
      next =
        record.type === 'fragment' && record.offset > 0
          ? nextAt(binding, record.record_index, record.offset)
          : previous(binding, record);
    const candidate = page(base, [record, ...items], next);
    if (bytes(candidate) <= maxBytes) {
      items.unshift(record);
      continue;
    }
    if (items.length) {
      const first = items[0];
      const before =
        first.type === 'fragment' && first.offset > 0
          ? nextAt(binding, first.record_index, first.offset)
          : previous(binding, first);
      return page(base, items, before);
    }
    if (record.type === 'fragment') {
      // Keep offsets relative to the original serialized record, not this page.
      const encoded = record.json_fragment,
        end = encoded.length;
      const build = (part, start) => {
        const item = {
          ...record,
          offset: record.offset + start,
          json_fragment: part.json_fragment,
        };
        const before = item.offset
          ? nextAt(binding, item.record_index, item.offset)
          : previous(binding, item);
        return page(base, [item], before);
      };
      const fitted = fitSuffix(record, encoded, end, maxBytes, build);
      return fitted.item.json_fragment.length ? build(fitted.item, fitted.start) : null;
    }
    const encoded = JSON.stringify(record);
    const build = (item, start) =>
      page(
        base,
        [item],
        start ? nextAt(binding, record.record_index, start) : previous(binding, record),
      );
    const fitted = fitSuffix(record, encoded, encoded.length, maxBytes, build);
    return fitted.item.json_fragment.length ? build(fitted.item, fitted.start) : null;
  }
  return page(base, items, result.next_cursor);
}
