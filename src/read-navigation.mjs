// Reading documents are indexes over already-authorized, sanitized units.
// They never reconstruct provider data or run tools to recover missing results.
const compact = (value) =>
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
  return { ...base, text: excerpt(row.text, low) };
}

function messageText(message, { metadata = false } = {}) {
  if (!message) return '';
  const texts = [];
  if (typeof message.command === 'string') texts.push(`command: ${message.command}`);
  if (message.role === 'bashExecution')
    texts.push(
      `exit: ${message.exitCode ?? 'unknown'}${message.cancelled ? '; cancelled' : ''}${message.truncated ? '; native output truncated' : ''}`,
    );
  if (message.errorMessage) texts.push(`error: ${message.errorMessage}`);
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
export function unitText(unit, metadata = false) {
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
const docUnits = (snapshot, doc) => doc.units ?? doc.indices.map((i) => snapshot.units[i]);
export const documentUnits = docUnits;
export const documentText = (snapshot, doc) =>
  docUnits(snapshot, doc)
    .map((u) => unitText(u, true))
    .join('');

function key(unit, index) {
  if (unit.tool_id) return `tool:${unit.tool_id}`;
  const s = unit.source ?? {};
  if (s.reader_item !== undefined) return `item:${s.reader_item}`;
  if (s.observation_index !== undefined) return `runtime:${s.observation_index}`;
  if (s.entry_id !== undefined)
    return `session:${s.entry_id}:${s.message_index ?? ''}:${s.block_index ?? ''}`;
  return `unit:${index}`;
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
  const counts = {};
  for (const c of rows) counts[c.name] = (counts[c.name] ?? 0) + 1;
  const args = call?.arguments ?? {};
  const target = ['path', 'file', 'command', 'query', 'url']
    .filter((k) => args[k] !== undefined)
    .map(
      (k) =>
        `${k}: ${excerpt(typeof args[k] === 'string' ? args[k] : JSON.stringify(args[k]), 120)}`,
    )
    .join('; ');
  const output = units
    .filter((u) => u.message?.role === 'toolResult')
    .map((u) => messageText(u.message))
    .join('');
  const summary = [
    call?.name ?? result?.toolName ?? 'tool',
    target,
    result?.isError ? 'result: error' : result ? 'result: returned' : 'result: not recorded',
    rows.length
      ? `recorded operations: ${rows.length} (${Object.entries(counts)
          .map(([k, v]) => `${k}×${v}`)
          .join(', ')}); errors/unfinished: ${errors.length}`
      : '',
    ...errors.slice(0, 3).map((c) => `${c.name}: ${c.status} ${excerpt(c.error, 180)}`),
    excerpt(output, 480),
  ]
    .filter(Boolean)
    .join('\n');
  return { summary, children: rows, name: call?.name ?? result?.toolName ?? 'tool' };
}

export function navigationDocuments(snapshot) {
  const grouped = new Map();
  snapshot.units.forEach((u, i) => {
    const id = key(u, i);
    if (!grouped.has(id))
      grouped.set(id, {
        id,
        kind: u.tool_id ? 'tool' : (u.kind ?? u.type),
        source: u.source,
        indices: [],
      });
    grouped.get(id).indices.push(i);
  });
  const docs = [...grouped.values()];
  for (const doc of [...docs]) {
    const units = docUnits(snapshot, doc);
    const body =
      units.find((u) => !['message_metadata', 'nested_call'].includes(u.type)) ?? units[0];
    if (doc.kind !== 'tool')
      doc.kind =
        doc.source?.observation_index !== undefined &&
        units.some((u) => u.message?.role === 'toolResult')
          ? 'tool_result'
          : (body.kind ?? body.type);
    doc.title = body.title;
    doc.preview = body.preview;
    doc.related = body.related;
    if (body.provenance) doc.source = { ...doc.source, ...body.provenance };
    if (
      typeof body.provenance?.source_entry_id === 'string' &&
      body.provenance.source_relation === 'history_leaf'
    ) {
      const position = docs.length;
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
          preset: 'recent',
        },
      });
      doc.sourceIndex = position;
    }
    if (doc.kind === 'tool' || doc.kind === 'tool_result') {
      const tool = toolPreview(units);
      doc.title = tool.name;
      doc.preview = tool.summary;
      doc.children = [];
      for (const child of tool.children) {
        const indices = doc.indices.filter((i) => snapshot.units[i].nested_call?.id === child.id);
        const position = docs.length;
        const childDoc = {
          id: `${doc.id}:nested:${child.id}`,
          parent: docs.indexOf(doc),
          kind: 'nested_call',
          title: child.name,
          source: doc.source,
          preview: `${child.name} ${excerpt(JSON.stringify(child.arguments ?? {}), 160)}\n${child.status}${child.error ? ': ' + excerpt(child.error, 240) : ''}`,
          ...(indices.length
            ? { indices }
            : { units: [{ type: 'nested_call', source: doc.source, nested_call: child }] }),
        };
        docs.push(childDoc);
        doc.children.push(position);
      }
    }
  }
  return docs;
}

export function navigationRows(snapshot, documents, ref, { query, types } = {}) {
  const matching = documents
    .map((doc, index) => ({ doc, index }))
    .filter(
      ({ doc }) =>
        (!types?.length || types.includes(doc.kind)) &&
        (query
          ? `${doc.title ?? ''}\n${documentText(snapshot, doc)}`
              .toLocaleLowerCase()
              .includes(query.toLocaleLowerCase())
          : doc.parent === undefined),
    );
  const parents = new Set(matching.map(({ doc }) => doc.parent).filter((x) => x !== undefined));
  return matching
    .filter(({ index }) => !query || !parents.has(index))
    .map(({ doc, index }) => {
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
      for (const i of [...new Set([...salient.slice(0, 3), ...children.slice(-2)])])
        related.push({ relation: 'operation', ref: ref(i) });
      return {
        type: doc.kind,
        ref: ref(index),
        ...(doc.title ? { title: doc.title } : {}),
        text: query
          ? excerpt(documentText(snapshot, doc), 640, query)
          : excerpt(
              doc.preview ?? documentText(snapshot, doc),
              doc.kind === 'prompt' || doc.kind === 'text' ? 1600 : 900,
            ),
        ...(doc.source ? { source: doc.source } : {}),
        ...(related.length ? { related } : {}),
      };
    });
}
