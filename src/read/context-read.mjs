import { readSchema, contextSelection, contentKind } from './read-schema.mjs';
import { z } from 'zod';
import { jsonBytes } from '../mcp/response-budget.mjs';
import { traceSessionBranch } from '../core/data.mjs';
import { validateReadAdapters } from './read-adapters.mjs';
import {
  navigationGroups,
  searchGroupMatches,
  assistantBlocks,
  assistantFailed,
  toolOperations,
} from './read-navigation.mjs';
import { READ_PAGE_LIMIT, boundedFields, pick, smallLive } from './read-render.mjs';
import { READ_SNAPSHOT_LIMIT, readSnapshotBytes } from './read-snapshots.mjs';

// Change only when the live read request/snapshot semantics become incompatible.
export const READ_CONTRACT = 'pi-bridge-read-v2';
export const OBSERVATION_PHASE = 'context_with_system_observer';
const count = z.number().int().nonnegative();
const leafId = z.string().nullable();
const observation = z.discriminatedUnion('available', [
  z
    .object({
      available: z.literal(false),
      reason: z.string(),
      current_leaf_id: z.unknown().optional(),
    })
    .refine(
      (capture) =>
        capture.reason !== 'no_observation' || leafId.safeParse(capture.current_leaf_id).success,
    ),
  z.object({
    available: z.literal(true),
    phase: z.literal(OBSERVATION_PHASE),
    id: z.string(),
    owner_generation: z.string(),
    observed_at: z.string(),
    checked_at: z.string(),
    owner_active: z.boolean(),
    current_leaf_id: leafId,
    input_leaf_id: leafId,
    later_committed_entries: count,
  }),
]);

const take = (values, n, reverse = false) =>
  n === -1 ? values : n === 0 ? [] : reverse ? values.slice(-n) : values.slice(0, n);

const messageKinds = {
  user: 'prompt',
  system: 'system',
  assistant: 'assistant',
  toolResult: 'tool_result',
  compactionSummary: 'summary',
  branchSummary: 'summary',
  bashExecution: 'command',
  custom: 'custom',
};

function messageKind(message) {
  return Object.hasOwn(messageKinds, message.role) ? messageKinds[message.role] : 'native';
}

function addMessage(records, message, type, source, prompt_id, runtime = false) {
  if (type === 'assistant') {
    const { content, ...metadata } = message;
    if (Array.isArray(content) && content.length) {
      for (const unit of assistantBlocks(content, source, prompt_id)) {
        if (!runtime || unit.type === 'text') unit.metadata = metadata;
        records.push(unit);
      }
      if (
        !assistantFailed(message) ||
        content.some((block) => block.type === 'text' && (!runtime || block.text?.trim()))
      )
        return;
      message = runtime ? metadata : { ...metadata, content: [] };
    }
    if (!runtime) type = 'native';
  }
  const record = { type, source, prompt_id, message };
  if (!runtime && type === 'summary') {
    delete record.message;
    record.parts = [{ source, message }];
  }
  if (!runtime && type === 'command') record.in_model_context = !message.excludeFromContext;
  records.push(record);
}

function linkTools(records, runtime = false) {
  const tools = toolOperations(records);
  for (const [first, result] of tools) {
    const call = first.type === 'tool_call';
    const { entry_id, message_index, observation_index, block_index = 'message' } = first.source;
    const id = runtime
      ? call
        ? `runtime:runtime:${observation_index}:${block_index}`
        : `tool:runtime:${observation_index}`
      : `${entry_id}:${message_index}:${block_index}:${first.type}`;
    first.tool_id = id;
    if (!runtime) {
      first.call_id = call ? first.block.id : first.message.toolCallId;
      first.pairing = result ? 'paired' : call ? 'unresolved' : 'orphan_result';
      if (result)
        Object.assign(result, {
          call_id: first.call_id,
          pairing: 'paired',
          call_source: first.source,
        });
    }
    if (result) {
      result.tool_id = id;
      if (!runtime || first.prompt_id !== null) result.prompt_id = first.prompt_id;
    }
  }
  return tools;
}

// A hidden input is a turn boundary even though it has no recoverable content.
function timeline(entries, readAdapters) {
  const records = [],
    prompts = [];
  let prompt = null;
  const adapterFor = (message) =>
    message?.role === 'custom' &&
    readAdapters.find(({ inputCustomTypes }) => inputCustomTypes.includes(message.customType));
  function promptBoundary(source, reason, role = 'user', message = { role, content: '' }) {
    prompt = reason ? `empty:${source.entry_id}:${reason}` : source.entry_id;
    prompts.push(prompt);
    records.push({
      type: 'prompt',
      prompt_id: prompt,
      source,
      synthetic: Boolean(reason),
      ...(reason ? { reason } : {}),
      message,
    });
  }
  for (const [entry_index, { sourceEntry: entry, messages }] of entries.entries()) {
    const base = { entry_id: entry.id, entry_index };
    if (!messages.length) {
      const original =
        entry.type === 'custom_message'
          ? { role: 'custom', customType: entry.customType }
          : entry.message;
      const adapter = adapterFor(original);
      if (original?.role === 'user') promptBoundary(base, 'hidden_user');
      else if (adapter)
        promptBoundary({ ...base, read_adapter: adapter.id }, 'hidden_input', 'custom');
    }
    for (const [message_index, message] of messages.entries()) {
      const type = messageKind(message);
      const adapter = adapterFor(message);
      const source = { ...base, message_index };
      if (type === 'prompt' || adapter) {
        if (adapter) source.read_adapter = adapter.id;
        promptBoundary(source, null, message.role, message);
        continue;
      }
      if (prompt === null && (type === 'assistant' || type === 'tool_result'))
        promptBoundary(base, 'context_prefix');
      addMessage(
        records,
        message,
        type,
        source,
        ['summary', 'system'].includes(type) ? null : prompt,
      );
    }
  }
  return { records, prompts, tools: linkTools(records) };
}

function selectTimeline(projected, { range, content }, readAdapters) {
  const { records, prompts, tools } = timeline(projected.entries, readAdapters);
  const turns = new Set([...take(prompts, range.earliest), ...take(prompts, range.recent, true)]);
  const recordsByKind = Map.groupBy(records, (record) =>
    record.message?.role === 'assistant' ? 'assistant' : contentKind(record.type),
  );
  const all = (kind) => recordsByKind.get(kind) ?? [];
  const inTurn = (record) => turns.has(record.prompt_id);
  const chosen = new Set();
  const omissions = { turns: prompts.length - turns.size };
  const keep = (kind, groups, selected) => {
    omissions[kind] = groups.length - selected.length;
    for (const group of selected) for (const record of group) chosen.add(record);
  };
  const globalSummary = all('summary');
  const individual = {
    input: (record) => content.input && inTurn(record),
    system: (record) => {
      if (!content.system) return false;
      if (content.tool !== 0) return true;
      const { toolsAdded, toolsRemoved, ...message } = record.message;
      record.message = message;
      return Boolean(message.content?.length || Object.keys(message.sections ?? {}).length);
    },
    native: (record) => content.native && (record.prompt_id === null || inTurn(record)),
  };
  for (const [kind, test] of Object.entries(individual)) {
    const groups = all(kind).map((record) => [record]);
    keep(
      kind,
      groups,
      groups.filter(([record]) => test(record)),
    );
  }
  const commands = all('command').map((record) => [record]);
  keep('command', commands, take(commands, content.command, true));
  const summaries = globalSummary.length ? [globalSummary] : [];
  keep('summary', summaries, content.summary !== 0 ? summaries : []);
  const meaningful = {
    assistant: (record) =>
      (typeof record.block?.text === 'string' && record.block.text.trim()) ||
      assistantFailed(record.metadata ?? record.message),
    thinking: (record) => typeof record.block.thinking === 'string' && record.block.thinking.trim(),
  };
  for (const kind of ['assistant', 'thinking', 'tool']) {
    const groups =
      kind === 'tool'
        ? tools
        : [
            ...Map.groupBy(
              all(kind),
              ({ source }) => `${source.entry_id}:${source.message_index}`,
            ).values(),
          ].filter((group) => group.some(meaningful[kind]));
    const selected = [];
    for (const [turn, group] of Map.groupBy(groups, ([first]) => first.prompt_id))
      if (turns.has(turn)) selected.push(...take(group, content[kind], true));
    keep(kind, groups, selected);
  }
  return {
    records: records.filter((record) => chosen.has(record)),
    latestPrompt: prompts.at(-1) ?? null,
    latestPromptSelected: turns.has(prompts.at(-1)),
    omissions,
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

// Capture runtime request messages directly in the detached source shape.
export function captureRuntimeUnits(messages) {
  const units = [];
  let prompt = null;
  for (const [observation_index, original] of messages.entries()) {
    const message = cleanMessage(original),
      type = messageKind(message);
    if (type === 'prompt') prompt = `runtime:${observation_index}`;
    addMessage(units, message, type, { observation_index }, prompt, true);
  }
  linkTools(units, true);
  if (readSnapshotBytes(units, units.length) > READ_SNAPSHOT_LIMIT)
    throw new Error('READ_SNAPSHOT_TOO_LARGE');
  return structuredClone(units);
}

export function appendSnapshotUnit(target, unit) {
  target.accountedBytes += readSnapshotBytes(unit, 1);
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

function entryRelations({ byId, ancestry, end }, ids) {
  // The raw parent chain includes ancestors omitted by compaction. A missing
  // parent prevents negative claims; entries reached on the chain are known.
  return Object.fromEntries(
    ids.map((id) => [
      id,
      ancestry.has(id) ? 'on_branch' : end === null && byId.has(id) ? 'off_branch' : 'unknown',
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
  const branch = traceSessionBranch(data.entries, leaf, data.byId);
  if (leaf !== null && !branch.ancestry.has(leaf)) throw new Error('ENTRY_NOT_FOUND');
  const selected = selectTimeline(
      buildSessionProjection(data.entries, leaf, branch.byId),
      selection,
      validateReadAdapters(readAdapters),
    ),
    target = { units: [], accountedBytes: 0 };
  if (search_query === undefined) {
    for (const record of selected.records) appendSnapshotUnit(target, cleanRecord(record));
  } else {
    const byPosition = [];
    for (const group of navigationGroups(selected.records)) {
      const atoms = group.atoms.map(({ position, unit }) => ({
        position,
        unit: cleanRecord(unit),
      }));
      if (searchGroupMatches({ ...group, atoms }, search_query))
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
    ...(requestedEntries ? { entry_relations: entryRelations(branch, requestedEntries) } : {}),
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
  const blocks = [...assistantBlocks(message.content, {}, null)],
    groups = Map.groupBy(blocks, ({ type }) => contentKind(type)),
    kept = new Set(selection.content.native ? groups.get('native') : []),
    omissions = { ...raw.selection_omissions };
  for (const kind of ['assistant', 'thinking', 'tool']) {
    const group = groups.get(kind) ?? [];
    // Live text/thinking belong to one transient message. Tool calls still
    // count independently because each is a distinct logical operation.
    const pick =
      kind === 'tool'
        ? take(group, selection.content.tool, true)
        : selection.content[kind]
          ? group
          : [];
    omissions[kind] =
      (omissions[kind] ?? 0) +
      (kind === 'tool' ? group.length - pick.length : Number(group.length > 0 && !pick.length));
    for (const item of pick) kept.add(item);
  }
  const items = blocks
    .filter((item) => kept.has(item))
    .map(({ block: rawBlock }) => {
      const block = structuredClone(cleanBlock(rawBlock));
      return { type: block.type === 'toolCall' ? 'tool_call' : block.type, block };
    });
  return smallLive(
    {
      ...base,
      items,
      selection_omissions: omissions,
      ...(raw.truncated || raw.upstream_truncated ? { upstream_truncated: true } : {}),
    },
    READ_PAGE_LIMIT,
  );
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
    (!count.safeParse(value.capture_sequence).success ||
      !observation.safeParse(value.observation).success ||
      (value.observation.available
        ? value.observation.input_leaf_id !== value.leaf_id
        : value.units?.length))
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
