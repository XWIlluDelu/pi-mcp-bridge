import { contentKind } from './read-schema.mjs';
import { largestFittingSize } from '../mcp/response-budget.mjs';

// References index source units in one frozen capture.
const compact = (value) =>
  String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '');
const inline = (value) =>
  String(value ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
const slice = (text, start, end = text.length) => {
  if (start < 0) start = Math.max(0, text.length + start);
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? '')) start++;
  if (/[\uD800-\uDBFF]/u.test(text[end - 1] ?? '')) end--;
  return text.slice(start, end);
};
function excerpt(text, limit = 640, query = '') {
  if (text.length <= limit) return text;
  if (limit < 8) return slice(text, 0, limit);
  const at = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
  if (at >= 0) {
    const start = Math.max(0, at - Math.floor(limit / 3));
    return `${start ? '…' : ''}${slice(text, start, start + limit - 2)}…`;
  }
  const head = Math.floor(limit * 0.65);
  return `${slice(text, 0, head)} … ${slice(text, -(limit - head - 3))}`;
}

// A brief row is a disposable preview; its reference retains the captured source.
export function fitNavigationRow(row, fits) {
  const base = { ...row };
  const shorten = (limit) => {
    const text = excerpt(row.text, limit);
    return { ...base, text, ...(text !== row.text ? { truncated: true } : {}) };
  };
  if (!fits(shorten(0))) delete base.source;
  if (!fits(shorten(0))) delete base.related;
  return shorten(largestFittingSize(row.text.length, (limit) => fits(shorten(limit))));
}

function messageText(message, { metadata = false } = {}) {
  if (!message) return '';
  const texts = [];
  if (typeof message.command === 'string') texts.push(`command: ${message.command}`);
  if (message.role === 'bashExecution')
    texts.push(
      `exit: ${message.exitCode ?? 'unknown'}${message.cancelled ? '; cancelled' : ''}${message.truncated ? '; native output truncated' : ''}`,
    );
  if (message.errorMessage && message.role !== 'assistant')
    texts.push(`error: ${message.errorMessage}`);
  for (const key of ['summary', 'output'])
    if (typeof message[key] === 'string') texts.push(message[key]);
  if (typeof message.content === 'string') texts.push(message.content);
  else
    for (const block of message.content ?? []) {
      if (block.type === 'text') texts.push(block.text ?? '');
      else if (block.type === 'image')
        texts.push(`[image ${block.mime_type ?? block.mimeType ?? 'unknown'}; data omitted]`);
      else if (block.type === 'thinking') texts.push(block.thinking ?? '');
      else if (block.type === 'toolCall')
        texts.push(`${block.name} ${JSON.stringify(block.arguments ?? {})}`);
    }
  for (const [name, value] of Object.entries(message.sections ?? {}))
    texts.push(`${name}\n${value}`);
  for (const name of ['toolsAdded', 'toolsRemoved'])
    if (message[name]?.length) texts.push(`${name}: ${JSON.stringify(message[name])}`);
  if (metadata && message.details) texts.push(JSON.stringify(message.details));
  if (metadata && message.nestedCalls) texts.push(JSON.stringify(message.nestedCalls));
  return texts.join('\n');
}
function unitBodyText(unit) {
  if (unit.text !== undefined) return String(unit.text);
  if (unit.nested_call) return JSON.stringify(unit.nested_call);
  if (unit.block) {
    const b = unit.block;
    return b.text ?? b.thinking ?? `${b.name ?? b.type} ${JSON.stringify(b.arguments ?? {})}`;
  }
  return [
    messageText(unit.message, { metadata: true }),
    ...(unit.parts ?? []).map((p) => messageText(p.message, { metadata: true })),
  ].join('\n');
}
function assistantFailure(units) {
  const messages = units
    .flatMap((unit) => [
      ...(unit.metadata ? [{ ...unit.metadata, role: 'assistant' }] : []),
      unit.message,
      ...(unit.parts ?? []).map((part) => part.message),
    ])
    .filter((message) => message?.role === 'assistant' && assistantFailed(message));
  const message = messages.find((value) => value.errorMessage) ?? messages[0];
  return message
    ? `assistant ${message.stopReason ?? 'error'}${message.errorMessage ? ': ' + message.errorMessage : ''}`
    : '';
}
export function nestedCall(units, doc) {
  return units[doc.position].message.nestedCalls.calls[doc.ordinal];
}

function documentText(units, doc) {
  if (!doc.positions) return JSON.stringify(nestedCall(units, doc));
  const members = doc.positions.map((position) => units[position]);
  const failure = doc.kind === 'thinking' ? '' : assistantFailure(members);
  return [failure, ...members.map(unitBodyText)].filter(Boolean).join('\n');
}

const messageKey = (source = {}) =>
  source.observation_index !== undefined
    ? `runtime:${source.observation_index}`
    : `session:${source.entry_id}:${source.message_index ?? ''}`;
export const assistantBlockType = ({ type }) =>
  type === 'toolCall' ? 'tool_call' : ['text', 'thinking'].includes(type) ? type : 'native';

export function* assistantBlocks(content, source, prompt_id) {
  for (const [block_index, block] of content.entries()) {
    yield {
      type: assistantBlockType(block),
      source: { ...source, block_index },
      prompt_id,
      block,
    };
  }
}
export const assistantFailed = (message) =>
  ['error', 'aborted'].includes(message.stopReason) || Boolean(message.errorMessage);

const toolCall = (units) => units.find((unit) => unit.block?.type === 'toolCall')?.block;
const toolResult = (units) => units.find((unit) => unit.message?.role === 'toolResult')?.message;
const toolName = (units) => toolCall(units)?.name ?? toolResult(units)?.toolName ?? 'tool';

function nestedToolCalls(units, positions) {
  const calls = new Map();
  for (const position of positions)
    for (const [ordinal, call] of (units[position].message?.nestedCalls?.calls ?? []).entries())
      calls.set(call.id, { position, ordinal, call });
  return calls.values();
}

function toolPreview({ documents, units }, doc, title) {
  const rows = doc.children.map((i) => nestedCall(units, documents[i]));
  const members = doc.positions.map((position) => units[position]);
  const result = toolResult(members);
  const errors = rows.filter((c) => c.status === 'error' || c.status === 'unfinished');
  const args = toolCall(members)?.arguments ?? {};
  const field = ['path', 'file', 'command', 'query', 'url'].find(
    (name) => args[name] !== undefined,
  );
  const target = field
    ? `${field}: ${excerpt(inline(typeof args[field] === 'string' ? args[field] : JSON.stringify(args[field])), 80)}`
    : '';
  const status = result?.isError ? 'error' : result ? 'returned' : 'result not recorded';
  const diagnostic = result?.isError ? excerpt(inline(messageText(result)), 100) : '';
  const operations = rows.length
    ? `${rows.length} operations: ${[...new Set(rows.map((c) => excerpt(inline(c.name), 24)))].slice(0, 3).join(', ')}${errors.length ? `; ${errors.length} error/unfinished` : ''}`
    : '';
  const failure = errors[0]
    ? `${errors[0].name}: ${errors[0].status}${errors[0].error ? ' ' + excerpt(inline(errors[0].error), 100) : ''}`
    : '';
  return [excerpt(inline(title), 48), target, status, operations, diagnostic || failure]
    .filter(Boolean)
    .join(' · ');
}

// Acquisition and navigation share message/kind runs and logical tool pairs.
// Keep one position per atom so a pair can straddle a steering input.
export function navigationGroups(sourceUnits, content) {
  const units = [],
    documents = [],
    byId = new Map();
  let sourceIndex = 0,
    run;
  for (const unit of sourceUnits) {
    const source = unit.source ?? {};
    const toolId = unit.tool_id;
    let kind = toolId ? 'tool' : contentKind(unit.kind ?? unit.type);
    if (unit.message?.role === 'assistant' && kind === 'native') kind = 'assistant';
    const message = messageKey(source);
    let id = `unit:${sourceIndex++}`;
    if (toolId) id = `tool:${toolId}`;
    else if (source.reader_item !== undefined) id = `item:${source.reader_item}`;
    else if (source.entry_id !== undefined || source.observation_index !== undefined) {
      const block = source.block_index ?? source.content_index;
      // An owner may have pruned nonmatching blocks before transfer. Use the
      // original positions so this does not join formerly disjoint runs.
      if (
        run?.message === message &&
        run.kind === kind &&
        (block === undefined || block === run.block || block === run.block + 1)
      )
        id = run.id;
      run = { message, kind, block, id };
    }
    if (content?.[kind] === false || content?.[kind] === 0) continue;
    if (!byId.has(id)) byId.set(id, documents.push({ kind, positions: [] }) - 1);
    documents[byId.get(id)].positions.push(units.push(unit) - 1);
  }
  return { documents, units, byId };
}

export function navigationIndex(snapshot, query) {
  const {
    documents: docs,
    units,
    byId,
  } = navigationGroups(snapshot.units, snapshot.request?.content);
  const latest = new Map();
  const order = [];
  const groups = docs.length;
  for (let parent = 0; parent < groups; parent++) {
    const doc = docs[parent];
    const { positions } = doc;
    const { related, provenance, tool_id, prompt_id, source } = units[positions[0]];
    doc.links = [];
    for (const { id, relation } of related ?? []) {
      const target = byId.get(`item:${id}`);
      if (target !== undefined) doc.links.push({ relation, target });
    }
    if (
      snapshot.view !== 'runtime' &&
      doc.kind === 'assistant' &&
      prompt_id != null &&
      positions.some((i) => units[i].block?.type === 'text' && units[i].block.text?.trim())
    )
      latest.set(prompt_id, messageKey(source));
    if (
      typeof provenance?.source_entry_id === 'string' &&
      provenance.source_relation === 'history_leaf'
    ) {
      doc.links.push({ relation: 'source_context', target: docs.length });
      docs.push({
        kind: 'source',
        parent,
        request: {
          session_id: snapshot.session_id,
          view: 'session',
          leaf_id: provenance.source_entry_id,
          range: { recent: 3 },
        },
      });
    }
    let childMatches = false;
    if (tool_id) {
      const children = (doc.children = []);
      const errors = [];
      for (const { position, ordinal, call } of nestedToolCalls(units, positions)) {
        const child = {
          parent,
          position,
          ordinal,
        };
        const index = docs.push(child) - 1;
        children.push(index);
        if (call.status === 'error' && errors.length < 2) errors.push(index);
        if (query && documentMatches(units, child, query)) {
          order.push(index);
          childMatches = true;
        }
      }
      for (const target of new Set([...errors, ...children.slice(-2)]))
        doc.links.push({ relation: 'operation', target });
    }
    // Matching children take their parent's position in the overview.
    if (!childMatches && (!query || documentMatches(units, doc, query))) order.push(parent);
  }
  for (const doc of docs) {
    if (doc.kind !== 'assistant') continue;
    const { prompt_id, source } = units[doc.positions[0]];
    if (prompt_id != null && latest.get(prompt_id) === messageKey(source)) doc.latest = true;
  }
  return { units, documents: docs, order };
}

const includesQuery = (text, query) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase());

export function matchesReadText(title, preview, text, query) {
  return [title, preview, text].some((value) => value && includesQuery(value, query));
}

const firstUnit = (units, doc) => units[doc.positions?.[0]];
const titleOf = (units, doc) => {
  const first = firstUnit(units, doc);
  if (first?.tool_id) return toolName(doc.positions.map((i) => units[i]));
  return first ? first.title : nestedCall(units, doc).name;
};

function documentMatches(units, doc, query) {
  return (
    doc.kind !== 'source' &&
    (matchesReadText(titleOf(units, doc), firstUnit(units, doc)?.preview, undefined, query) ||
      includesQuery(documentText(units, doc), query))
  );
}

// Owner acquisition retains matching sources before transfer. Links and
// previews belong to the public snapshot and are built once, after capture.
export function searchGroupMatches(units, group, query) {
  return (
    documentMatches(units, group, query) ||
    Boolean(
      firstUnit(units, group).tool_id &&
      nestedToolCalls(units, group.positions).some(({ call }) =>
        matchesReadText(call.name, undefined, JSON.stringify(call), query),
      ),
    )
  );
}

// A match found only in a reader preview is shown from that preview.
function searchedText(units, doc, query) {
  const text = documentText(units, doc);
  const preview = firstUnit(units, doc)?.preview;
  return preview && !includesQuery(text, query) && includesQuery(preview, query) ? preview : text;
}

export function navigationRow(index, offset, ref, query) {
  const { documents, units } = index;
  const doc = documents[offset];
  const related = doc.links
    ? doc.links.map(({ relation, target }) => ({ relation, ref: ref(target) }))
    : [{ relation: 'parent', ref: ref(doc.parent) }];
  const root = firstUnit(units, doc);
  const title = titleOf(units, doc);
  const tool = !query && doc.children !== undefined;
  const full = compact(
    query
      ? searchedText(units, doc, query)
      : tool
        ? toolPreview(index, doc, title)
        : (root.preview ?? documentText(units, doc)),
  );
  const text = tool ? full : excerpt(full, query ? 640 : doc.latest ? 3000 : 900, query);
  const source = root?.provenance
    ? { ...root.source, ...root.provenance }
    : root
      ? (root.source ?? {})
      : units[doc.position]?.source;
  return {
    type: doc.kind ?? 'tool',
    ref: ref(offset),
    text,
    ...(title ? { title } : {}),
    ...(text !== full ? { truncated: true } : {}),
    ...(source ? { source } : {}),
    ...(root?.branch_relation ? { branch_relation: root.branch_relation } : {}),
    ...(related.length ? { related } : {}),
  };
}
