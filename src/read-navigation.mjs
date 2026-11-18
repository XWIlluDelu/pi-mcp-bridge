import { contentKind } from './read-schema.mjs';

// Reading documents own sanitized source atoms and their original positions.
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
export function excerpt(value, limit = 640, query = '') {
  const text = compact(value);
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
  let low = 0,
    high = row.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(shorten(mid))) low = mid;
    else high = mid - 1;
  }
  return shorten(low);
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
function unitBodyText(unit, metadata = false) {
  if (unit.text !== undefined) return String(unit.text);
  if (unit.nested_call) return JSON.stringify(unit.nested_call);
  if (unit.block) {
    const b = unit.block;
    return b.text ?? b.thinking ?? `${b.name ?? b.type} ${JSON.stringify(b.arguments ?? {})}`;
  }
  return [
    messageText(unit.message, { metadata }),
    ...(unit.parts ?? []).map((p) => messageText(p.message, { metadata })),
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
function nestedCall(documents, doc) {
  return documents[doc.parent].atoms[doc.atom].unit.message.nestedCalls.calls[doc.ordinal];
}

export function* documentAtoms(documents, doc) {
  if (doc.parent === undefined) yield* doc.atoms;
  else {
    const { position, unit } = documents[doc.parent].atoms[doc.atom];
    yield {
      position,
      child: doc.ordinal,
      unit: {
        type: 'nested_call',
        source: { ...unit.source, nested_call_index: doc.ordinal },
        nested_call: nestedCall(documents, doc),
      },
    };
  }
}

function documentText(documents, doc) {
  const units = [...documentAtoms(documents, doc)].map(({ unit }) => unit);
  const failure = doc.kind === 'thinking' ? '' : assistantFailure(units);
  return [failure, ...units.map((unit) => unitBodyText(unit, true))].filter(Boolean).join('\n');
}

const messageKey = (source = {}) =>
  source.observation_index !== undefined
    ? `runtime:${source.observation_index}`
    : `session:${source.entry_id}:${source.message_index ?? ''}`;
export const assistantBlockType = (block) =>
  ({ text: 'text', thinking: 'thinking', toolCall: 'tool_call' })[block.type] ?? 'native';
export const assistantFailed = (message) =>
  ['error', 'aborted'].includes(message.stopReason) || Boolean(message.errorMessage);

// Classify captured assistant blocks once, keeping original source order.
export function runtimeUnits(atoms) {
  const units = [];
  let turn = null;
  for (const original of atoms) {
    const message = original.message;
    if (message?.role === 'user') turn = `runtime:${original.source.observation_index}`;
    if (
      message?.role !== 'assistant' ||
      !Array.isArray(message.content) ||
      !message.content.length
    ) {
      units.push({ ...original, prompt_id: turn });
      continue;
    }
    const { content, ...metadata } = message;
    for (const [index, block] of content.entries())
      units.push({
        type: assistantBlockType(block),
        metadata: block.type === 'text' ? metadata : undefined,
        block,
        source: { ...original.source, block_index: index },
        prompt_id: turn,
      });
    if (
      assistantFailed(message) &&
      !content.some((block) => block.type === 'text' && block.text?.trim())
    )
      units.push({ ...original, message: metadata, prompt_id: turn });
  }
  const open = new Map();
  for (const unit of units) {
    if (unit.block?.type === 'toolCall') {
      const id = `runtime:${messageKey(unit.source)}:${unit.source.block_index}`;
      unit.tool_id = id;
      const stack = open.get(unit.block.id) ?? [];
      stack.push(unit);
      open.set(unit.block.id, stack);
    } else if (unit.message?.role === 'toolResult') {
      const source = messageKey(unit.source);
      const call = open.get(unit.message.toolCallId)?.pop();
      unit.tool_id = call?.tool_id ?? `tool:${source}`;
      unit.prompt_id = call?.prompt_id ?? unit.prompt_id;
    }
  }
  return units;
}

function toolName(units) {
  return (
    units.find((unit) => unit.block?.type === 'toolCall')?.block.name ??
    units.find((unit) => unit.message?.role === 'toolResult')?.message.toolName ??
    'tool'
  );
}

function toolPreview(documents, doc) {
  const units = doc.atoms.map(({ unit }) => unit);
  const rows = doc.children.map((i) => nestedCall(documents, documents[i]));
  const call = units.find((u) => u.block?.type === 'toolCall')?.block;
  const result = units.find((u) => u.message?.role === 'toolResult')?.message;
  const errors = rows.filter((c) => c.status === 'error' || c.status === 'unfinished');
  const args = call?.arguments ?? {};
  const field = ['path', 'file', 'command', 'query', 'url'].find(
    (name) => args[name] !== undefined,
  );
  const target = field
    ? `${field}: ${excerpt(inline(typeof args[field] === 'string' ? args[field] : JSON.stringify(args[field])), 80)}`
    : '';
  const status = result?.isError ? 'error' : result ? 'returned' : 'result not recorded';
  // Only explicit failure output is a diagnostic. Successful stdout stays in
  // the tool reference, not in the default activity directory.
  const diagnostic = result?.isError
    ? excerpt(
        inline(
          units
            .filter((u) => u.message?.role === 'toolResult')
            .map((u) => messageText(u.message))
            .join(''),
        ),
        100,
      )
    : '';
  const operations = rows.length
    ? `${rows.length} operations: ${[...new Set(rows.map((c) => excerpt(inline(c.name), 24)))].slice(0, 3).join(', ')}${errors.length ? `; ${errors.length} error/unfinished` : ''}`
    : '';
  const failure = errors[0]
    ? `${errors[0].name}: ${errors[0].status}${errors[0].error ? ' ' + excerpt(inline(errors[0].error), 100) : ''}`
    : '';
  return [excerpt(inline(doc.title), 48), target, status, operations, diagnostic || failure]
    .filter(Boolean)
    .join(' · ');
}

// Acquisition and navigation share message/kind runs and logical tool pairs.
// Keep one position per atom so a pair can straddle a steering input.
export function navigationGroups(units, content) {
  const grouped = new Map();
  let run;
  for (const [i, unit] of units.entries()) {
    const source = unit.source ?? {};
    const toolId = unit.tool_id;
    let kind = toolId ? 'tool' : contentKind(unit.kind ?? unit.type);
    if (unit.message?.role === 'assistant' && kind === 'native') kind = 'assistant';
    const message = messageKey(source);
    let id = `unit:${i}`;
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
    if (!grouped.has(id))
      grouped.set(id, {
        id,
        kind,
        source,
        prompt_id: unit.prompt_id,
        message,
        atoms: [],
      });
    grouped.get(id).atoms.push({ position: i, unit });
  }
  return [...grouped.values()];
}

export function navigationDocuments(snapshot) {
  const docs = navigationGroups(snapshot.units, snapshot.request?.content);
  const byId = new Map(docs.map((doc, index) => [doc.id, index]));
  const latest = new Map();
  for (const [parent, doc] of [...docs].entries()) {
    const units = doc.atoms.map(({ unit }) => unit);
    const { title, related, branch_relation, provenance } = units[0];
    Object.assign(doc, { title, branch_relation, links: [] });
    for (const { id, relation } of related ?? []) {
      const target = byId.get(`item:${id}`);
      if (target !== undefined) doc.links.push({ relation, target });
    }
    if (
      snapshot.view !== 'runtime' &&
      doc.kind === 'assistant' &&
      doc.prompt_id != null &&
      units.some((unit) => unit.block?.type === 'text' && unit.block.text?.trim())
    )
      latest.set(doc.prompt_id, doc.message);
    if (provenance) doc.source = { ...doc.source, ...provenance };
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
    if (doc.kind !== 'tool') continue;
    const calls = new Map();
    for (const [atom, unit] of units.entries())
      for (const [ordinal, call] of (unit.message?.nestedCalls?.calls ?? []).entries())
        calls.set(call.id, { atom, ordinal, call });
    const children = [...calls.values()];
    doc.title = toolName(units);
    doc.children = children.map(
      ({ atom, ordinal, call }) =>
        docs.push({
          parent,
          atom,
          ordinal,
          kind: 'tool',
          title: call.name,
          source: units[atom].source,
          links: [{ relation: 'parent', target: parent }],
        }) - 1,
    );
    const errors = doc.children.filter((i) => nestedCall(docs, docs[i]).status === 'error');
    for (const target of new Set([...errors.slice(0, 2), ...doc.children.slice(-2)]))
      doc.links.push({ relation: 'operation', target });
  }
  for (const doc of docs)
    if (
      doc.kind === 'assistant' &&
      doc.prompt_id != null &&
      latest.get(doc.prompt_id) === doc.message
    )
      doc.latest = true;
  return docs;
}

const includesQuery = (text, query) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase());

export function matchesReadText(title, preview, text, query) {
  return [title, preview, text].some((value) => value && includesQuery(value, query));
}

export function documentMatches(documents, doc, query) {
  return (
    doc.kind !== 'source' &&
    matchesReadText(doc.title, doc.atoms?.[0].unit.preview, documentText(documents, doc), query)
  );
}

// A match found only in a reader preview is shown from that preview.
function searchedText(documents, doc, query) {
  const text = documentText(documents, doc);
  const preview = doc.atoms?.[0].unit.preview;
  return preview && !includesQuery(text, query) && includesQuery(preview, query) ? preview : text;
}

export function navigationOrder(documents, query) {
  const order = [...documents.keys()];
  if (!query) return order.filter((index) => documents[index].parent === undefined);
  const matching = order.filter((index) => documentMatches(documents, documents[index], query));
  const parents = new Set(matching.map((index) => documents[index].parent));
  // Child operations occupy their parent's source position, even though their
  // reference documents are appended after the top-level document index.
  return matching
    .filter((index) => !parents.has(index))
    .sort((a, b) => (documents[a].parent ?? a) - (documents[b].parent ?? b) || a - b);
}

export function navigationRow(documents, index, ref, query) {
  const doc = documents[index];
  const related = doc.links.map(({ relation, target }) => ({ relation, ref: ref(target) }));
  const tool = !query && doc.kind === 'tool';
  const full = compact(
    query
      ? searchedText(documents, doc, query)
      : tool
        ? toolPreview(documents, doc)
        : (doc.atoms[0].unit.preview ?? documentText(documents, doc)),
  );
  const text = tool ? full : excerpt(full, query ? 640 : doc.latest ? 3000 : 900, query);
  return {
    type: doc.kind,
    ref: ref(index),
    text,
    ...(doc.title ? { title: doc.title } : {}),
    ...(text !== full ? { truncated: true } : {}),
    ...(doc.source ? { source: doc.source } : {}),
    ...(doc.branch_relation ? { branch_relation: doc.branch_relation } : {}),
    ...(related.length ? { related } : {}),
  };
}
