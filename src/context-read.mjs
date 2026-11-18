import { readSchema, contextSelection, DEFAULT_READ_BYTES } from './read-schema.mjs';
import { jsonBytes, resultSize } from './response-budget.mjs';
import { boundRuntimeEvents } from './runtime-events.mjs';
import { sessionEntryIndex } from './data.mjs';
import { validateReadAdapters } from './read-adapters.mjs';
import {
  fitNavigationRow,
  navigationGroups,
  navigationDocuments,
  documentMatches,
  assistantBlockType,
  assistantFailed,
} from './read-navigation.mjs';

// Change only when the live read request/snapshot semantics become incompatible.
export const READ_CONTRACT = 'pi-bridge-read-v2';
export const READ_SNAPSHOT_LIMIT = 32 * 1024 * 1024;
const READ_PAGE_LIMIT = 65536;
const UNIT_TARGET = 2048;

const take = (values, n, reverse = false) =>
  n === -1 ? values : n === 0 ? [] : reverse ? values.slice(-n) : values.slice(0, n);

/**
 * The projection, not timestamps or raw-file order, is the ordering authority.
 * Retain hidden inputs as empty boundaries before flattening messages.
 */
function timeline(projection, readAdapters) {
  const records = [],
    prompts = [];
  let prompt = null;
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
  function emptyPrompt(source, reason, role = 'user') {
    prompt = `empty:${source.entry_id}:${reason}`;
    prompts.push(prompt);
    add('prompt', source, { synthetic: true, reason, message: { role, content: '' } });
  }
  const inputAdapter = (message) =>
    message?.role === 'custom'
      ? readAdapters.find((value) => value.inputCustomTypes.includes(message.customType))
      : undefined;
  function requirePrompt(source) {
    if (prompt === null) {
      const { message_index, block_index, ...entrySource } = source;
      emptyPrompt(entrySource, 'context_prefix');
    }
  }
  for (const [entryIndex, projected] of projection.entries.entries()) {
    const { sourceEntry: entry, messages } = projected;
    const base = { entry_id: entry.id, entry_index: entryIndex };
    if (!messages.length) {
      const original =
        entry.type === 'custom_message'
          ? { role: 'custom', customType: entry.customType }
          : entry.type === 'message'
            ? entry.message
            : null;
      const adapter = inputAdapter(original);
      if (original?.role === 'user') emptyPrompt(base, 'hidden_user');
      else if (adapter)
        emptyPrompt({ ...base, read_adapter: adapter.id }, 'hidden_input', 'custom');
    }
    for (const [messageIndex, message] of messages.entries()) {
      const source = { ...base, message_index: messageIndex };
      const adapter = inputAdapter(message);
      if (message.role === 'user' || adapter) {
        // Classify the input before selection, without rewriting its native role
        // or payload. Source links identify both the entry and opt-in mapping.
        if (adapter) source.read_adapter = adapter.id;
        prompt = entry.id;
        prompts.push(prompt);
        add('prompt', source, { synthetic: false, message });
      } else if (message.role === 'compactionSummary' || message.role === 'branchSummary') {
        add('summary', source, { parts: [{ source, message }] }, null);
      } else if (message.role === 'system') {
        add('system', source, { message }, null);
      } else if (message.role === 'assistant') {
        requirePrompt(source);
        const { content, ...metadata } = message;
        if (Array.isArray(content) && content.length) {
          for (const [blockIndex, block] of content.entries()) {
            add(
              assistantBlockType(block),
              { ...source, block_index: blockIndex },
              { block, metadata },
            );
          }
          // A failed message can contain only thinking or an unfinished call.
          // Its status belongs to assistant selection, not to those other kinds.
          if (!content.some((block) => block.type === 'text') && assistantFailed(metadata))
            add('native', source, { message: { ...metadata, content: [] } });
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

function selectTimeline(projected, selection, readAdapters) {
  const { records, prompts, units } = timeline(projected, readAdapters);
  const { range, content } = selection;
  const selectedPrompts = new Set([
    ...take(prompts, range.earliest),
    ...take(prompts, range.recent, true),
  ]);
  const chosen = new Set();
  const totals = {
    turns: prompts.length,
    input: prompts.length,
    assistant: 0,
    thinking: 0,
    tool: units.size,
    system: records.filter((r) => r.type === 'system').length,
    summary: records.some((r) => r.type === 'summary') ? 1 : 0,
    command: records.filter((r) => r.type === 'command').length,
    native: 0,
  };
  const included = Object.fromEntries(Object.keys(totals).map((key) => [key, 0]));
  included.turns = selectedPrompts.size;
  const assistantRecord = (record) =>
    record.type === 'text' || (record.type === 'native' && record.message?.role === 'assistant');
  // Each content kind selects messages independently. Once a message qualifies,
  // retain all its selected-kind blocks, never just a first/last block sample.
  for (const kind of ['assistant', 'thinking']) {
    const messages = new Map();
    for (const record of records) {
      if (kind === 'assistant' ? !assistantRecord(record) : record.type !== 'thinking') continue;
      const key = `${record.source.entry_id}:${record.source.message_index}`;
      const message = messages.get(key) ?? {
        prompt_id: record.prompt_id,
        records: [],
        readable: false,
      };
      message.records.push(record);
      const value = kind === 'assistant' ? record.block?.text : record.block?.thinking;
      message.readable ||=
        (typeof value === 'string' && value.trim().length > 0) ||
        (kind === 'assistant' && assistantFailed(record.metadata ?? record.message ?? {}));
      messages.set(key, message);
    }
    const groups = new Map();
    for (const message of messages.values()) {
      if (!message.readable) continue;
      totals[kind]++;
      const group = groups.get(message.prompt_id) ?? [];
      group.push(message);
      groups.set(message.prompt_id, group);
    }
    for (const [id, group] of groups) {
      if (!selectedPrompts.has(id)) continue;
      for (const message of take(group, content[kind], true)) {
        included[kind]++;
        for (const record of message.records) chosen.add(record);
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
    if (selectedPrompts.has(id))
      for (const unit of take(group, content.tool, true)) {
        included.tool++;
        for (const record of unit.records) chosen.add(record);
      }
  for (const record of take(
    records.filter((r) => r.type === 'command'),
    content.command,
    true,
  )) {
    chosen.add(record);
    included.command++;
  }
  for (const record of records) {
    if (record.type === 'system') {
      if (!content.system) continue;
      if (content.tool === 0) {
        const { toolsAdded, toolsRemoved, ...message } = record.message;
        if (!message.content?.length && !Object.keys(message.sections ?? {}).length) continue;
        record.message = message;
      }
      chosen.add(record);
      included.system++;
    } else if (record.type === 'prompt') {
      if (content.input && selectedPrompts.has(record.prompt_id)) {
        chosen.add(record);
        included.input++;
      }
    } else if (record.type === 'summary') {
      if (content.summary !== 0) {
        chosen.add(record);
        included.summary = 1;
      }
    } else if (['custom', 'native'].includes(record.type) && !assistantRecord(record)) {
      // Other extension/native content stays in its own input window; global
      // context prefixes remain independent of turn selection.
      totals.native++;
      if (content.native && (record.prompt_id === null || selectedPrompts.has(record.prompt_id))) {
        chosen.add(record);
        included.native++;
      }
    }
  }
  return {
    records: records.filter((record) => chosen.has(record)),
    latestPrompt: prompts.at(-1) ?? null,
    latestPromptSelected: selectedPrompts.has(prompts.at(-1)),
    omissions: Object.fromEntries(
      Object.keys(totals).map((key) => [key, totals[key] - included[key]]),
    ),
  };
}

// Only native fields are reduced. Tool arguments, details and unknown business
// objects are not recursively filtered by property name.
const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]),
  );
const messageFields = [
  'role',
  'timestamp',
  'model',
  'provider',
  'thinkingLevel',
  'stopReason',
  'errorMessage',
  'toolCallId',
  'toolName',
  'isError',
  'customType',
  'display',
  'details',
  'command',
  'exitCode',
  'cancelled',
  'truncated',
  'excludeFromContext',
  'fullOutputPath',
  'fromId',
  'firstKeptEntryId',
  'tokensBefore',
];
function boundedFields(value) {
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
function cleanBlock(block) {
  if (block?.type === 'image')
    return {
      type: 'image',
      mime_type: block.mimeType ?? block.mime_type ?? null,
      data_omitted: true,
    };
  if (block?.type === 'text') return { type: 'text', text: block.text ?? '' };
  if (block?.type === 'thinking')
    return { type: 'thinking', thinking: block.thinking ?? '', ...pick(block, ['redacted']) };
  if (block?.type === 'toolCall')
    return boundedFields(
      pick(block, [
        'type',
        'id',
        'name',
        'namespace',
        'arguments',
        'argumentsError',
        'arguments_error',
      ]),
    );
  return boundedFields(block && typeof block === 'object' ? block : { value: block });
}
function cleanMessage(message) {
  const fields = pick(message, messageFields);
  const result = boundedFields(fields);
  if (message?.content !== undefined)
    result.content = Array.isArray(message.content)
      ? message.content.map(cleanBlock)
      : message.content;
  if (message?.nestedCalls !== undefined) result.nestedCalls = message.nestedCalls;
  // Known system sections/tool declarations are splittable reading content.
  // They must not be discarded as one oversized metadata object.
  for (const key of ['summary', 'output', 'sections', 'toolsAdded', 'toolsRemoved'])
    if (message?.[key] !== undefined) result[key] = message[key];
  return result;
}
function cleanRecord(record) {
  const result = pick(record, [
    'type',
    'prompt_id',
    'source',
    'synthetic',
    'reason',
    'tool_id',
    'call_id',
    'pairing',
    'call_source',
    'in_model_context',
  ]);
  const sourceFields = [
    'entry_id',
    'entry_index',
    'message_index',
    'block_index',
    'observation_index',
    'reader_item',
    'content_kind',
    'read_adapter',
  ];
  if (record.source) result.source = pick(record.source, sourceFields);
  if (record.call_source) result.call_source = pick(record.call_source, sourceFields);
  if (record.block) {
    result.block = cleanBlock(record.block);
    const metadata = boundedFields(
      pick(record.metadata, [
        'timestamp',
        'model',
        'provider',
        'thinkingLevel',
        'stopReason',
        'errorMessage',
      ]),
    );
    if (Object.keys(metadata).length) result.metadata = metadata;
  }
  if (record.message) result.message = cleanMessage(record.message);
  if (record.parts)
    result.parts = record.parts.map(({ source, message }) => ({
      source,
      message: cleanMessage(message),
    }));
  return result;
}

// Split only for the response. Keep source text intact and use stable part
// boundaries so a continuation can change its page budget.
function* textParts(text) {
  if (typeof text !== 'string' || !text.length) {
    yield text;
    return;
  }
  for (let start = 0; start < text.length;) {
    // Each UTF-16 unit takes at least one encoded byte. Align the slice
    // to a code point before measuring, since JSON escapes lone surrogates.
    let end = Math.min(text.length, start + UNIT_TARGET - 2);
    const slice = (index) =>
      text.slice(start, text.codePointAt(index - 1) > 0xffff ? index - 1 : index);
    let part = slice(end);
    if (jsonBytes(part) > UNIT_TARGET) {
      let low = start;
      while (low < end) {
        const mid = Math.ceil((low + end) / 2);
        if (jsonBytes(slice(mid)) <= UNIT_TARGET) low = mid;
        else end = mid - 1;
      }
      part = slice(low);
    }
    yield part;
    start += part.length;
  }
}
function* splitText(record, text, replace) {
  const parts = textParts(text),
    first = parts.next(),
    second = parts.next();
  if (second.done) {
    yield record;
    return;
  }
  let index = 1;
  yield { ...replace(first.value), part: index++ };
  yield { ...replace(second.value), part: index++ };
  for (const part of parts) yield { ...replace(part), part: index++ };
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
export function appendUnits(target, record) {
  appendCleanUnit(target, cleanRecord(record));
}

function appendCleanUnit(target, unit) {
  target.accountedBytes += jsonBytes(unit) * 4 + 256;
  if (target.accountedBytes > READ_SNAPSHOT_LIMIT) throw new Error('READ_SNAPSHOT_TOO_LARGE');
  target.units.push(structuredClone(unit));
}
export function validateReadEntryIds(value) {
  if (
    !Array.isArray(value) ||
    value.length > 10000 ||
    value.some((id) => typeof id !== 'string' || !id || id.length > 128)
  )
    throw new Error('INVALID_READ_ARGUMENTS');
  return [...new Set(value)].sort();
}

function entryRelations(byId, leaf, ids) {
  const ancestry = new Set();
  let current = leaf;
  while (current !== null) {
    const entry = byId.get(current);
    if (!entry) break;
    ancestry.add(current);
    current = entry.parentId;
  }
  // The raw parent chain includes ancestors omitted by compaction. A missing
  // parent prevents negative claims; entries reached on the chain are known.
  return Object.fromEntries(
    ids.map((id) => [
      id,
      ancestry.has(id) ? 'on_branch' : current === null && byId.has(id) ? 'off_branch' : 'unknown',
    ]),
  );
}

export function prepareContextRead(data, rawArgs, { buildSessionProjection, readAdapters = [] }) {
  // Internal owner acquisition predicate. Public search supplies it only after
  // validating its own schema; public read does not accept this field.
  const { search_query, entry_ids, ...readArgs } = rawArgs;
  const requestedEntries = entry_ids === undefined ? undefined : validateReadEntryIds(entry_ids);
  if (
    search_query !== undefined &&
    (typeof search_query !== 'string' || !search_query.trim() || search_query.length > 2048)
  )
    throw new Error('INVALID_READ_ARGUMENTS');
  const parsed = readSchema.safeParse(readArgs);
  if (!parsed.success) throw new Error('INVALID_READ_ARGUMENTS');
  const args = parsed.data;
  if (args.cursor !== undefined || args.view === 'runtime')
    throw new Error('INVALID_READ_ARGUMENTS');
  const selection = contextSelection(args),
    leaf =
      args.leaf_id === undefined
        ? data.leafId === undefined
          ? (data.entries.at(-1)?.id ?? null)
          : data.leafId
        : args.leaf_id;
  if (leaf !== null && !data.entries.some((entry) => entry.id === leaf))
    throw new Error('ENTRY_NOT_FOUND');
  const byId = sessionEntryIndex(data.entries, leaf);
  const selected = selectTimeline(
      buildSessionProjection(data.entries, leaf, byId),
      selection,
      validateReadAdapters(readAdapters),
    ),
    target = { units: [], accountedBytes: 0 };
  if (search_query === undefined) {
    for (const record of selected.records) appendUnits(target, record);
  } else {
    const matches = [];
    for (const group of navigationGroups(selected.records)) {
      const units = group.atoms.map(({ unit }) => cleanRecord(unit));
      const documents = navigationDocuments({ units });
      if (documents.some((doc) => documentMatches(documents, doc, search_query))) {
        for (const [i, { position }] of group.atoms.entries()) {
          appendCleanUnit(target, units[i]);
          matches.push(position);
        }
      }
    }
    target.units = target.units
      .map((unit, i) => ({ unit, position: matches[i] }))
      .sort((a, b) => a.position - b.position)
      .map(({ unit }) => unit);
  }
  return {
    contract: READ_CONTRACT,
    view: 'session',
    session_id: args.session_id,
    leaf_id: leaf,
    selection,
    omissions: selected.omissions,
    ...(requestedEntries ? { entry_relations: entryRelations(byId, leaf, requestedEntries) } : {}),
    ...(search_query !== undefined ? { search_query } : {}),
    units: target.units,
    ...(data.history ? { history: data.history } : {}),
    live: args.leaf_id === undefined ? cleanLive(data.live, selection, selected) : null,
  };
}

function cleanLive(raw, selection, selected) {
  if (!raw)
    return {
      available: false,
      source: 'snapshot',
      transient: true,
      reason: 'native_events_unavailable',
    };
  const base = {
    source: String(raw.source ?? 'native_message_events').slice(0, 100),
    available: raw.available !== false,
    transient: true,
    complete: false,
    observed_at: typeof raw.observed_at === 'string' ? raw.observed_at.slice(0, 100) : null,
    prompt_id: selected.latestPrompt,
  };
  if (!base.available)
    return { ...base, reason: String(raw.reason ?? 'unavailable').slice(0, 200) };
  if (
    raw.omitted_by_selection ||
    (selected.latestPrompt !== null && !selected.latestPromptSelected)
  )
    return { ...base, omitted_by_selection: true };
  const message = raw.message;
  if (message === null) return { ...base, items: [] };
  if (message?.role !== 'assistant' || !Array.isArray(message.content))
    return { ...base, available: false, reason: 'invalid_live_message' };
  const indices = new Set(),
    omissions = { ...raw.selection_omissions };
  for (const [kind, key] of [
    ['text', 'assistant'],
    ['thinking', 'thinking'],
    ['toolCall', 'tool'],
  ]) {
    const group = message.content
      .map((block, index) => ({ block, index }))
      .filter((item) => item.block.type === kind);
    // Live text/thinking belong to one transient message. Tool calls still
    // count independently because each is a distinct logical operation.
    const keep =
      key === 'tool'
        ? take(group, selection.content.tool, true)
        : selection.content[key] === 0
          ? []
          : group;
    omissions[key] =
      (omissions[key] ?? 0) +
      (key === 'tool' ? group.length - keep.length : group.length && !keep.length ? 1 : 0);
    for (const { index } of keep) indices.add(index);
  }
  if (selection.content.native)
    message.content.forEach((block, index) => {
      if (!['text', 'thinking', 'toolCall'].includes(block.type)) indices.add(index);
    });
  const result = {
    ...base,
    items: [],
    selection_omissions: omissions,
    ...(raw.truncated || raw.upstream_truncated ? { upstream_truncated: true } : {}),
  };
  for (const index of [...indices].sort((a, b) => a - b)) {
    const block = cleanBlock(message.content[index]),
      type = block.type === 'toolCall' ? 'tool_call' : block.type;
    result.items.push({ type, block: structuredClone(block) });
  }
  return smallLive(result, READ_PAGE_LIMIT);
}
function smallLive(live, budget) {
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
    ...(snapshot.query ? { query: snapshot.query } : {}),
    ...(snapshot.query ? { matches: units.length } : {}),
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
  render: while (offset < units.length) {
    const atom = units.at(offset);
    const parts = rows ? [atom].values() : pageParts(atom);
    let next = parts.next();
    for (let i = 0; i < part && !next.done; i++) next = parts.next();
    if (next.done) throw new Error('INVALID_CURSOR');
    const atomOffset = offset;
    while (!next.done) {
      let unit = next.value;
      next = parts.next();
      const nextOffset = next.done ? atomOffset + 1 : atomOffset;
      const nextPart = next.done ? 0 : part + 1;
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
          if (items.length && metadataUnit(unit)) break render;
          unit = omittedUnit(unit);
          cost = unitSize(unit);
        }
      }
      const measured = pageWith(cost);
      if (!fits(measured)) {
        if (items.length) break render;
        if (measured.bytes <= max && resultBudget) throw new Error('BATCH_QUERY_BUDGET_TOO_SMALL');
        const error = new Error('READ_BUDGET_TOO_SMALL');
        error.minimum_max_bytes = measured.bytes;
        throw error;
      }
      items.push(unit);
      itemBytes += cost.bytes;
      itemWireBytes += cost.wireBytes;
      part = nextPart;
    }
    offset = atomOffset + 1;
  }
  const result = page(items, offset, part);
  if (!fits(size(result))) throw new Error('READ_BUDGET_TOO_SMALL');
  return structuredClone(result);
}
export function assertReadSnapshot(value, args) {
  if (value?.contract !== READ_CONTRACT) throw new Error('OWNER_READ_REFRESH_REQUIRED');
  if (value.search_query !== args.search_query) throw new Error('INVALID_OWNER_READ');
  if (args.entry_ids !== undefined) {
    const ids = validateReadEntryIds(args.entry_ids);
    if (
      !value.entry_relations ||
      typeof value.entry_relations !== 'object' ||
      Array.isArray(value.entry_relations) ||
      Object.keys(value.entry_relations).length !== ids.length ||
      ids.some(
        (id) =>
          !Object.hasOwn(value.entry_relations, id) ||
          !['on_branch', 'off_branch', 'unknown'].includes(value.entry_relations[id]),
      )
    )
      throw new Error('INVALID_OWNER_READ');
  }
  const observed = args.view === 'runtime';
  if (
    observed &&
    (!Number.isSafeInteger(value.capture_sequence) ||
      value.capture_sequence < 0 ||
      typeof value.observation?.available !== 'boolean' ||
      (value.observation.available &&
        (value.observation.phase !== 'context_with_system_observer' ||
          typeof value.observation.id !== 'string' ||
          typeof value.observation.owner_generation !== 'string' ||
          typeof value.observation.observed_at !== 'string' ||
          typeof value.observation.checked_at !== 'string' ||
          typeof value.observation.owner_active !== 'boolean' ||
          !(
            value.observation.current_leaf_id === null ||
            typeof value.observation.current_leaf_id === 'string'
          ) ||
          !Number.isSafeInteger(value.observation.later_committed_entries) ||
          value.observation.later_committed_entries < 0 ||
          value.observation.input_leaf_id !== value.leaf_id)) ||
      (!value.observation.available &&
        (typeof value.observation.reason !== 'string' ||
          value.units?.length ||
          (value.observation.reason === 'no_observation' &&
            !(
              value.observation.current_leaf_id === null ||
              typeof value.observation.current_leaf_id === 'string'
            )))))
  )
    throw new Error('INVALID_OWNER_READ');
  if (
    value.session_id !== args.session_id ||
    value.view !== (observed ? 'runtime' : 'session') ||
    !Array.isArray(value.units) ||
    (observed
      ? value.selection !== null || value.omissions !== null
      : [
          'turns',
          'input',
          'assistant',
          'thinking',
          'tool',
          'command',
          'system',
          'summary',
          'native',
        ].some(
          (key) => !Number.isSafeInteger(value.omissions?.[key]) || value.omissions[key] < 0,
        )) ||
    !(value.leaf_id === null || typeof value.leaf_id === 'string') ||
    (args.leaf_id !== undefined && value.leaf_id !== args.leaf_id) ||
    (!observed && JSON.stringify(value.selection) !== JSON.stringify(contextSelection(args))) ||
    jsonBytes(value) > READ_SNAPSHOT_LIMIT ||
    value.units.some(
      (unit) =>
        typeof unit?.type !== 'string' ||
        (observed
          ? !Number.isSafeInteger(unit.source?.observation_index) ||
            unit.source.observation_index < 0 ||
            unit.source.entry_id !== undefined
          : typeof unit.source?.entry_id !== 'string'),
    )
  )
    throw new Error('INVALID_OWNER_READ');
  return value;
}
