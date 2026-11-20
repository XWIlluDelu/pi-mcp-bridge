import { readSchema, contextSelection } from './read-schema.mjs';
import { jsonBytes } from '../mcp/response-budget.mjs';
import { sessionEntryIndex } from '../core/data.mjs';
import { validateReadAdapters } from './read-adapters.mjs';
import {
  navigationGroups,
  navigationDocuments,
  documentMatches,
  assistantBlockType,
  assistantFailed,
  toolOperations,
} from './read-navigation.mjs';
import {
  READ_PAGE_LIMIT,
  boundedFields,
  pick,
  renderPreparedContextRead,
  smallLive,
} from './read-render.mjs';

export { renderPreparedContextRead };

// Change only when the live read request/snapshot semantics become incompatible.
export const READ_CONTRACT = 'pi-bridge-read-v2';
export const READ_SNAPSHOT_LIMIT = 32 * 1024 * 1024;

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
    records.push({ type, prompt_id: owner, source, ...extra });
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
  // A result belongs to its original call even after a steering input.
  const tools = toolOperations(records);
  for (const [first, result] of tools) {
    const call = first.type === 'tool_call';
    const { entry_id, message_index, block_index = 'message' } = first.source;
    first.tool_id = `${entry_id}:${message_index}:${block_index}:${first.type}`;
    first.call_id = call ? first.block.id : first.message.toolCallId;
    first.pairing = result ? 'paired' : call ? 'unresolved' : 'orphan_result';
    if (result)
      Object.assign(result, {
        tool_id: first.tool_id,
        call_id: first.call_id,
        pairing: 'paired',
        prompt_id: first.prompt_id,
        call_source: first.source,
      });
  }
  return { records, prompts, tools };
}

function selectTimeline(projected, selection, readAdapters) {
  const { records, prompts, tools } = timeline(projected, readAdapters);
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
    tool: tools.length,
    system: records.filter((r) => r.type === 'system').length,
    summary: records.some((r) => r.type === 'summary') ? 1 : 0,
    command: records.filter((r) => r.type === 'command').length,
    native: 0,
  };
  const included = Object.fromEntries(Object.keys(totals).map((key) => [key, 0]));
  included.turns = selectedPrompts.size;
  const assistantRecord = (record) =>
    record.type === 'text' || (record.type === 'native' && record.message?.role === 'assistant');
  // Count messages and operations, then keep their complete selected blocks.
  const selectRecent = (kind, groups) => {
    totals[kind] = groups.length;
    for (const [id, group] of Map.groupBy(groups, (records) => records[0].prompt_id)) {
      if (!selectedPrompts.has(id)) continue;
      for (const records of take(group, content[kind], true)) {
        included[kind]++;
        for (const record of records) chosen.add(record);
      }
    }
  };
  const hasText = (value) => typeof value === 'string' && value.trim().length > 0;
  for (const [kind, accepts, readable] of [
    [
      'assistant',
      assistantRecord,
      (record) => hasText(record.block?.text) || assistantFailed(record.metadata ?? record.message),
    ],
    [
      'thinking',
      (record) => record.type === 'thinking',
      (record) => hasText(record.block.thinking),
    ],
  ]) {
    const messages = Map.groupBy(
      records.filter(accepts),
      ({ source }) => `${source.entry_id}:${source.message_index}`,
    );
    selectRecent(
      kind,
      [...messages.values()].filter((group) => group.some(readable)),
    );
  }
  selectRecent('tool', tools);
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

// Source locators and pairing fields are built by Bridge. Native payloads pass
// through their own field selection before entering the detached snapshot.
function cleanRecord({ block, metadata, message, parts, ...unit }) {
  if (block) {
    unit.block = cleanBlock(block);
    const fields = boundedFields(
      pick(metadata, [
        'timestamp',
        'model',
        'provider',
        'thinkingLevel',
        'stopReason',
        'errorMessage',
      ]),
    );
    if (Object.keys(fields).length) unit.metadata = fields;
  }
  if (message) unit.message = cleanMessage(message);
  if (parts)
    unit.parts = parts.map(({ source, message }) => ({ source, message: cleanMessage(message) }));
  return unit;
}

export function appendUnits(target, record) {
  appendSnapshotUnit(target, cleanRecord(record));
}

export function appendSnapshotUnit(target, unit) {
  target.accountedBytes += jsonBytes(unit) * 4 + 256;
  if (target.accountedBytes > READ_SNAPSHOT_LIMIT) throw new Error('READ_SNAPSHOT_TOO_LARGE');
  const captured = structuredClone(unit);
  target.units.push(captured);
  return captured;
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
  const byId = sessionEntryIndex(data.entries, leaf, data.byId);
  if (leaf !== null && !byId.has(leaf)) throw new Error('ENTRY_NOT_FOUND');
  const selected = selectTimeline(
      buildSessionProjection(data.entries, leaf, byId),
      selection,
      validateReadAdapters(readAdapters),
    ),
    target = { units: [], accountedBytes: 0 };
  if (search_query === undefined) {
    for (const record of selected.records) appendUnits(target, record);
  } else {
    const byPosition = [];
    const source = { view: 'session', session_id: args.session_id };
    for (const group of navigationGroups(selected.records)) {
      const atoms = group.atoms.map(({ position, unit }) => ({
        position,
        unit: cleanRecord(unit),
      }));
      const documents = navigationDocuments(source, [{ ...group, atoms }]);
      if (documents.some((doc) => documentMatches(documents, doc, search_query)))
        for (const { position, unit } of atoms)
          byPosition[position] = appendSnapshotUnit(target, unit);
    }
    target.units = byPosition.filter(Boolean);
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
