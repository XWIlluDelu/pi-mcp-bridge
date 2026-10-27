import { contentKind } from './read-schema.mjs';

// Reading documents are indexes over already-authorized, sanitized units.
// They never reconstruct provider data or run tools to recover missing results.
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
  if (!fits({ ...base, text: '' })) delete base.source;
  if (!fits({ ...base, text: '' })) delete base.related;
  let low = 0,
    high = row.text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits({ ...base, text: excerpt(row.text, mid) })) low = mid;
    else high = mid - 1;
  }
  const text = excerpt(row.text, low);
  return { ...base, text, ...(text !== row.text ? { truncated: true } : {}) };
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
    .filter(
      (message) =>
        message?.role === 'assistant' &&
        (['error', 'aborted'].includes(message.stopReason) || message.errorMessage),
    );
  const message = messages.find((value) => value.errorMessage) ?? messages[0];
  return message
    ? `assistant ${message.stopReason ?? 'error'}${message.errorMessage ? ': ' + message.errorMessage : ''}`
    : '';
}
const docUnits = (snapshot, doc) => doc.units ?? doc.indices.map((i) => snapshot.units[i]);
export const documentUnits = docUnits;

// System sections and tool descriptions repeat their field labels in source
// pages. Rejoin only consecutive parts of the same field for searchable text.
function systemField(unit) {
  const message = unit.message;
  if (message?.role !== 'system') return null;
  const sections = Object.entries(message.sections ?? {});
  if (sections.length === 1 && typeof sections[0][1] === 'string') {
    const [name, text] = sections[0];
    return {
      key: JSON.stringify([unit.source, 'sections', name]),
      text,
      replace: (value) => ({ ...message, sections: { [name]: value } }),
    };
  }
  for (const key of ['toolsAdded', 'toolsRemoved']) {
    const tools = message[key];
    if (tools?.length !== 1 || typeof tools[0]?.description !== 'string') continue;
    const { description, ...fields } = tools[0];
    return {
      key: JSON.stringify([unit.source, key, fields]),
      text: description,
      replace: (value) => ({ ...message, [key]: [{ ...fields, description: value }] }),
    };
  }
  return null;
}

export function documentText(snapshot, doc) {
  const units = docUnits(snapshot, doc);
  if (units.length && units.every((unit) => unit.message?.role === 'bashExecution')) {
    // Source parts repeat execution facts so each reference page is readable.
    // Search one continuous output body, with those facts included only once.
    const message = {};
    let output;
    for (const unit of units) {
      Object.assign(message, unit.message);
      if (typeof unit.message.output === 'string') output = (output ?? '') + unit.message.output;
    }
    if (output !== undefined) message.output = output;
    return messageText(message, { metadata: true });
  }
  let body = '',
    previousBlock,
    previousSystemField = false;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index],
      field = systemField(unit);
    let text = unitBodyText(unit, true);
    if (field && unit.part === 1) {
      const parts = [field.text];
      while (index + 1 < units.length) {
        const next = units[index + 1],
          nextField = systemField(next);
        if (next.part !== parts.length + 1 || nextField?.key !== field.key) break;
        parts.push(nextField.text);
        index++;
      }
      text = messageText(field.replace(parts.join('')), { metadata: true });
    }
    if (!text) continue;
    const block = unit.source?.block_index ?? unit.source?.content_index;
    if (
      body &&
      (field ||
        previousSystemField ||
        (block !== undefined && previousBlock !== undefined && block !== previousBlock))
    )
      body += '\n';
    body += text;
    previousBlock = block;
    previousSystemField = Boolean(field);
  }
  // Split bodies repeat their stop reason, while the error detail lives once
  // in shared metadata. Keep each failure fact once beside the complete text.
  return [doc.kind === 'thinking' ? '' : assistantFailure(units), body].filter(Boolean).join('\n');
}

const messageKey = (source = {}) =>
  source.observation_index !== undefined
    ? `runtime:${source.observation_index}`
    : `session:${source.entry_id}:${source.message_index ?? ''}`;
const blockKey = (source = {}) =>
  `${messageKey(source)}:${source.block_index ?? source.content_index ?? ''}`;

// A runtime capture remains untouched. Navigation applies kind filtering to a
// derived view, including individual assistant blocks rather than the whole
// mixed assistant message. References still contain the captured source.
function runtimeUnits(snapshot) {
  const units = [];
  let turn = null;
  for (const original of snapshot.units) {
    const message = original.message;
    if (message?.role === 'user') turn = `runtime:${original.source.observation_index}`;
    if (message?.role === 'assistant' && Array.isArray(message.content) && message.content.length) {
      const { content, ...metadata } = message;
      for (const [index, block] of content.entries())
        units.push({
          ...original,
          message: undefined,
          metadata,
          block,
          type:
            block.type === 'text'
              ? 'text'
              : block.type === 'thinking'
                ? 'thinking'
                : block.type === 'toolCall'
                  ? 'tool_call'
                  : 'native',
          source: { ...original.source, block_index: original.source.content_index ?? index },
          prompt_id: turn,
        });
    } else units.push({ ...original, prompt_id: turn });
  }
  // Failure metadata is an assistant fact even if the message has only
  // thinking/tool blocks and those kinds are switched off.
  const failures = new Map();
  for (const unit of snapshot.units) {
    const message = unit.message;
    if (
      message?.role === 'assistant' &&
      (['error', 'aborted'].includes(message.stopReason) || message.errorMessage)
    )
      failures.set(messageKey(unit.source), {
        ...failures.get(messageKey(unit.source)),
        ...message,
      });
  }
  for (const [key, message] of failures) {
    const positions = units
      .map((unit, index) => (messageKey(unit.source) === key ? index : -1))
      .filter((index) => index >= 0);
    if (
      positions.some(
        (index) => units[index].block?.type === 'text' && units[index].block.text?.trim().length,
      )
    )
      continue;
    const standalone = positions.find(
      (index) =>
        units[index].message?.role === 'assistant' && !units[index].message.content?.length,
    );
    if (standalone !== undefined) units[standalone].type = 'assistant';
    else {
      const previous = units[positions.at(-1)];
      units.splice(positions.at(-1) + 1, 0, {
        type: 'assistant',
        source: { observation_index: previous.source.observation_index },
        prompt_id: previous.prompt_id,
        message: { ...message, content: [] },
      });
    }
  }
  const open = new Map(),
    results = new Map();
  for (const unit of units) {
    if (unit.block?.type === 'toolCall') {
      const id = `runtime:${blockKey(unit.source)}`;
      unit.tool_id = id;
      const stack = open.get(unit.block.id) ?? [];
      stack.push(unit);
      open.set(unit.block.id, stack);
    } else if (unit.message?.role === 'toolResult') {
      const source = messageKey(unit.source);
      let pair = results.get(source);
      if (!pair) {
        const call = open.get(unit.message.toolCallId)?.pop();
        pair = { id: call?.tool_id ?? `tool:${source}`, turn: call?.prompt_id ?? unit.prompt_id };
        results.set(source, pair);
      }
      unit.tool_id = pair.id;
      unit.prompt_id = pair.turn;
    }
  }
  return units;
}

function toolPreview(units) {
  const call = units.find((u) => u.block?.type === 'toolCall')?.block;
  const result = units.find((u) => u.message?.role === 'toolResult')?.message;
  const children = new Map();
  for (const u of units) {
    for (const c of u.message?.nestedCalls?.calls ?? []) children.set(c.id, c);
    if (u.nested_call) children.set(u.nested_call.id, u.nested_call);
  }
  const rows = [...children.values()];
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
  return {
    summary: [
      excerpt(inline(call?.name ?? result?.toolName ?? 'tool'), 48),
      target,
      status,
      operations,
      diagnostic || failure,
    ]
      .filter(Boolean)
      .join(' · '),
    children: rows,
    name: call?.name ?? result?.toolName ?? 'tool',
  };
}

// Acquisition and navigation share message/kind runs and logical tool pairs.
// Grouping holds source indexes only, before any selected content is copied.
export function navigationGroups(units, content) {
  const enabled = (kind) =>
    !content || Array.isArray(content)
      ? !content?.length || content.includes(kind)
      : content[kind] !== false && content[kind] !== 0;
  const blockKinds = new Map(),
    messageBodies = new Map();
  for (const unit of units)
    if (unit.type !== 'message_metadata') {
      const kind = unit.tool_id ? 'tool' : contentKind(unit.kind ?? unit.type);
      blockKinds.set(blockKey(unit.source), kind);
      const message = messageKey(unit.source),
        previous = messageBodies.get(message);
      if (!previous || (kind === 'assistant' && previous.kind !== 'assistant'))
        messageBodies.set(message, { kind, source: unit.source, tool_id: unit.tool_id });
    }
  const grouped = new Map(),
    runs = new Map(),
    keys = new Map();
  for (const [i, unit] of units.entries()) {
    let source = unit.source ?? {},
      toolId = unit.tool_id;
    let kind = unit.tool_id ? 'tool' : contentKind(unit.kind ?? unit.type);
    if (unit.type === 'message_metadata') {
      const body = messageBodies.get(messageKey(source));
      kind =
        blockKinds.get(blockKey(source)) ??
        body?.kind ??
        (unit.message?.role === 'assistant' ? 'assistant' : 'native');
      // Message-level metadata belongs to that message's body, not an empty
      // native navigation row. Its original source remains in the reference.
      if (!blockKinds.has(blockKey(source)) && body) {
        source = body.source;
        toolId = body.tool_id;
      }
    }
    if (unit.message?.role === 'assistant' && kind === 'native') kind = 'assistant';
    const message = messageKey(source);
    let id;
    if (toolId) {
      id = `tool:${toolId}`;
      runs.set(message, { kind: 'tool', index: (runs.get(message)?.index ?? 0) + 1 });
    } else if (source.reader_item !== undefined) id = `item:${source.reader_item}`;
    else if (source.entry_id !== undefined || source.observation_index !== undefined) {
      const block = blockKey(source);
      id = keys.get(block);
      if (!id) {
        const previous = runs.get(message);
        const run = previous?.kind === kind ? previous.index : (previous?.index ?? 0) + 1;
        runs.set(message, { kind, index: run });
        id = `${message}:${kind}:${run}`;
        keys.set(block, id);
      }
    } else id = `unit:${i}`;
    if (!enabled(contentKind(kind))) continue;
    if (!grouped.has(id))
      grouped.set(id, {
        id,
        kind,
        source,
        prompt_id: unit.prompt_id,
        message,
        indices: [],
      });
    const doc = grouped.get(id);
    doc.indices.push(i);
  }
  return [...grouped.values()].sort((a, b) => {
    const bodyIndex = (doc) =>
      doc.indices.find((i) => !['message_metadata', 'nested_call'].includes(units[i].type)) ??
      doc.indices[0];
    return bodyIndex(a) - bodyIndex(b);
  });
}

export function navigationDocuments(snapshot) {
  const runtime = snapshot.view === 'runtime';
  const units = runtime ? runtimeUnits(snapshot) : snapshot.units;
  const docs = navigationGroups(units, snapshot.request?.content);
  if (runtime) for (const doc of docs) doc.units = doc.indices.map((index) => units[index]);
  for (const doc of [...docs]) {
    const values = docUnits(snapshot, doc);
    const body =
      values.find((u) => !['message_metadata', 'nested_call'].includes(u.type)) ?? values[0];
    doc.title = body.title;
    doc.preview = body.preview;
    doc.related = body.related;
    doc.branch_relation = body.branch_relation;
    if (body.provenance) doc.source = { ...doc.source, ...body.provenance };
    if (
      typeof body.provenance?.source_entry_id === 'string' &&
      body.provenance.source_relation === 'history_leaf'
    ) {
      doc.sourceIndex = docs.length;
      docs.push({
        id: `${doc.id}:source`,
        kind: 'source',
        parent: docs.indexOf(doc),
        title: 'Session context at the source boundary',
        indices: [],
        source: doc.source,
        request: {
          session_id: snapshot.session_id,
          view: 'session',
          leaf_id: body.provenance.source_entry_id,
          range: { recent: 3 },
        },
      });
    }
    if (doc.kind === 'tool') {
      const tool = toolPreview(values);
      doc.title = tool.name;
      doc.preview = tool.summary;
      doc.children = [];
      for (const child of tool.children) {
        const childUnits = values.filter((u) => u.nested_call?.id === child.id);
        const index = docs.length;
        docs.push({
          id: `${doc.id}:nested:${child.id}`,
          parent: docs.indexOf(doc),
          kind: 'tool',
          title: child.name,
          source: doc.source,
          preview: `${child.name} · ${child.status}${child.error ? ': ' + excerpt(inline(child.error), 140) : ''}`,
          units: childUnits.length
            ? childUnits
            : [{ type: 'nested_call', source: doc.source, nested_call: child }],
        });
        doc.children.push(index);
      }
    }
  }
  return docs;
}

export function documentMatches(snapshot, doc, query) {
  return `${doc.title ?? ''}\n${documentText(snapshot, doc)}`
    .toLocaleLowerCase()
    .includes(query.toLocaleLowerCase());
}

export function navigationRows(snapshot, documents, ref, { query, content } = {}) {
  const matching = documents
    .map((doc, index) => ({ doc, index }))
    .filter(
      ({ doc }) =>
        (!content?.length || content.includes(contentKind(doc.kind))) &&
        (query ? documentMatches(snapshot, doc, query) : doc.parent === undefined),
    );
  const parents = new Set(matching.map(({ doc }) => doc.parent).filter((x) => x !== undefined));
  const selected = matching.filter(({ index }) => !query || !parents.has(index));
  // Child operations occupy their parent's source position, even though their
  // reference documents are appended after the top-level document index.
  if (query)
    selected.sort(
      (a, b) => (a.doc.parent ?? a.index) - (b.doc.parent ?? b.index) || a.index - b.index,
    );
  const latest = new Map();
  if (!query && snapshot.view !== 'runtime')
    for (const { doc } of selected)
      if (
        doc.kind === 'assistant' &&
        docUnits(snapshot, doc).some((u) => u.block?.type === 'text' && u.block.text?.trim().length)
      )
        latest.set(doc.prompt_id, doc.message);
  return selected.map(({ doc, index }) => {
    const related = (doc.related ?? [])
      .map((link) => {
        const target = documents.findIndex((d) => d.id === `item:${link.id}`);
        return target >= 0 ? { relation: link.relation, ref: ref(target) } : null;
      })
      .filter(Boolean);
    if (doc.parent !== undefined) related.push({ relation: 'parent', ref: ref(doc.parent) });
    if (doc.sourceIndex !== undefined)
      related.push({ relation: 'source_context', ref: ref(doc.sourceIndex) });
    const children = doc.children ?? [];
    const salient = children.filter((i) =>
      documentText(snapshot, documents[i]).includes('"status":"error"'),
    );
    for (const i of [...new Set([...salient.slice(0, 2), ...children.slice(-2)])])
      related.push({ relation: 'operation', ref: ref(i) });
    const isLatest =
      doc.kind === 'assistant' &&
      doc.prompt_id != null &&
      latest.get(doc.prompt_id) === doc.message;
    const full = compact(
      query ? documentText(snapshot, doc) : (doc.preview ?? documentText(snapshot, doc)),
    );
    let text;
    if (query) text = excerpt(full, 640, query);
    else if (doc.kind === 'tool') text = full;
    else text = excerpt(full, ['input', 'assistant', 'thinking'].includes(doc.kind) ? 1600 : 900);
    return {
      type: doc.kind,
      ref: ref(index),
      text,
      ...(doc.title ? { title: doc.title } : {}),
      ...(text !== full ? { truncated: true } : {}),
      ...(doc.source ? { source: doc.source } : {}),
      ...(doc.branch_relation ? { branch_relation: doc.branch_relation } : {}),
      ...(related.length ? { related } : {}),
      _turn: query ? null : (doc.prompt_id ?? null),
      _latest: isLatest,
    };
  });
}
