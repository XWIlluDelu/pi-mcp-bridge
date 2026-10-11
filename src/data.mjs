import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildSessionProjection, migrateSessionEntries } from '@earendil-works/pi-coding-agent';
import { overviewRecords } from './overview.mjs';
import { activityObservation } from './activity.mjs';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const opaqueId = value => `ps_${hash(value).slice(0, 32)}`;
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'w', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, file);
  await syncDir(path.dirname(file));
}
export async function syncDir(dir) {
  const handle = await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
// Cooperative storage boundary: reject aliases instead of changing public IDs.
// Checks do not exclude concurrent filesystem edits by the same Unix owner.
export async function assertSingleSessionFile(file, {allowMissing=false}={}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  let stat;
  try { stat = await fs.lstat(file); }
  catch (error) { if (allowMissing && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || await fs.realpath(file) !== file) throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  return stat;
}
export async function loadSession(file) {
  const stat = await assertSingleSessionFile(file);
  if (stat.size > 32 * 1024 * 1024) throw new Error('SESSION_TOO_LARGE');
  const text = await fs.readFile(file, 'utf8');
  const lines = text.split('\n');
  const raw = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { raw.push(JSON.parse(lines[i])); } catch { throw new Error('INVALID_SESSION'); }
  }
  const header = raw[0];
  if (header?.type !== 'session' || typeof header.id !== 'string' || header.id.length > 128 || !path.isAbsolute(header.cwd ?? '')) throw new Error('INVALID_SESSION');
  if (header.version !== 3) throw new Error('UNSUPPORTED_SESSION_VERSION');
  migrateSessionEntries(raw); // In memory only, never opens SessionManager or rewrites disk.
  const entries = raw.slice(1);
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 128 || seen.has(entry.id) || (entry.parentId != null && !seen.has(entry.parentId))) throw new Error('INVALID_SESSION_TREE');
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) throw new Error('INVALID_SESSION');
    seen.add(entry.id);
  }
  return { header, entries, leafId: entries.at(-1)?.id ?? null, revision: hash(text), file };
}
export async function discover(config) {
  const found = [];
  async function walk(dir) {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink() || ent.name.startsWith('.')) continue;
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(file);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const data = await loadSession(file);
          const cwd = await fs.realpath(data.header.cwd);
          found.push({ ...data, id: opaqueId(`${file}\0${data.header.id}`), cwd });
        } catch { /* Invalid or partially written files are not exposed. */ }
      }
    }
  }
  for (const root of config.sessionRoots) await walk(root);
  return found.sort((a,b) => a.id.localeCompare(b.id));
}
export function recordsFor(data, args) {
  let entries = data.entries;
  if (args.since) {
    if (args.view !== 'raw') throw new Error('SINCE_REQUIRES_RAW');
    const index = entries.findIndex(x => x.id === args.since);
    if (index < 0) throw new Error('ENTRY_NOT_FOUND');
    entries = entries.slice(index + 1);
  }
  let records;
  if (args.view === 'raw') records = entries.map(e => ({ entry_id: e.id, entry: e }));
  else {
    if (args.leaf_id !== undefined && args.leaf_id !== null && !entries.some(e => e.id === args.leaf_id)) throw new Error('ENTRY_NOT_FOUND');
    const projection = buildSessionProjection(entries, args.leaf_id === undefined ? data.leafId : args.leaf_id);
    // Retained raw ranges can contain superseded checkpoints or context-hidden
    // summaries. Only entries contributing to this leaf's projection are active.
    if (args.view === 'overview') records = overviewRecords(projection);
    else if (args.view === 'summary') records = projection.entries.filter(e => e.messages.length > 0 && ['compaction','branch_summary'].includes(e.sourceEntry.type)).map(e => ({entry_id:e.sourceEntry.id, type:e.sourceEntry.type, summary:e.sourceEntry.summary}));
    else records = projection.entries.flatMap(e => e.messages.map((message, i) => ({entry_id:e.sourceEntry.id, message_index:i, message})));
  }
  if (args.entry_id) records = records.filter(e => e.entry_id === args.entry_id);
  if (args.query) records = records.filter(e => JSON.stringify(e).toLowerCase().includes(args.query.toLowerCase()));
  return records;
}
// One selector and renderer for saved files, RPC snapshots and attachments.
export function renderRead(data,args,{leafSource='saved_resume',generation}={}) {
  const view=args.view??'context',leaf=view!=='raw'&&args.leaf_id!==undefined?args.leaf_id:data.leafId;
  return {view,leaf_id:leaf,activity:data.activity??activityObservation(),...(generation===undefined?{}:{generation}),
    context_kind:['context','overview'].includes(view)?'pi_session_projection_not_final_provider_payload':undefined,
    ...(view==='overview'?{leaf_source:leafSource,leaf_selection:args.leaf_id===undefined?'current':'explicit',append_tail:data.entries.at(-1)?.id??null}:{}),
    ...pageRecords(recordsFor(data,{...args,view}),{...args,view},data.revision)};
}
// Pagination also handles a single enormous record. No hidden truncation.
export function pageRecords(records, args, revision) {
  const signature = hash({ session_id:args.session_id, view:args.view, entry_id:args.entry_id, since:args.since, query:args.query, leaf_id:args.leaf_id });
  let index = 0, offset = 0;
  if (args.cursor) {
    let c; try { c = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()); } catch { throw new Error('INVALID_CURSOR'); }
    if (c.signature !== signature || c.revision !== revision) throw new Error('STALE_CURSOR');
    if (!Number.isSafeInteger(c.index) || c.index < 0 || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new Error('INVALID_CURSOR');
    ({index, offset} = c);
  }
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  let remaining = Math.min(32768, Math.max(256, args.max_chars ?? 12000));
  const items = [];
  while (index < records.length && items.length < limit && remaining > 0) {
    const record = records[index];
    const encoded = JSON.stringify(record);
    if (offset > encoded.length) throw new Error('INVALID_CURSOR');
    const amount = Math.min(remaining, encoded.length - offset);
    if (offset === 0 && amount === encoded.length) items.push(record);
    else items.push({entry_id:record.entry_id, json_fragment:encoded.slice(offset, offset + amount), char_offset:offset, total_chars:encoded.length});
    remaining -= amount; offset += amount;
    if (offset >= encoded.length) { index++; offset = 0; }
  }
  const next_cursor = index < records.length ? Buffer.from(JSON.stringify({signature,revision,index,offset})).toString('base64url') : null;
  return {items, next_cursor, revision, total_items:records.length};
}
