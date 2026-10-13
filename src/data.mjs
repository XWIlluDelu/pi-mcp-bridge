import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildSessionProjection } from '@earendil-works/pi-coding-agent';
import { overviewRecords, OVERVIEW_EXTRACTOR_VERSION } from './overview.mjs';
import { activityObservation } from './activity.mjs';
import { hasTextSelector, readSchema } from './tool-schemas.mjs';
import { hash, opaqueId } from './storage.mjs';
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
function validateHeader(header) {
  if (header?.type !== 'session' || typeof header.id !== 'string' || !header.id || header.id.length > 128 || !path.isAbsolute(header.cwd ?? '')) throw new Error('INVALID_SESSION');
  if (header.version !== 3) throw new Error('UNSUPPORTED_SESSION_VERSION');
  return header;
}
// Identity discovery never parses transcript bodies. Bound the control header,
// independently of history size; keep an unavailable cwd separate from identity.
export async function readSessionIdentity(file) {
  const expected = await assertSingleSessionFile(file);
  const fd = await fs.open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let header;
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== expected.ino || opened.dev !== expected.dev) throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      // Most headers fit in one small read; extend only while looking for LF.
      const {bytesRead} = await fd.read(bytes,length,Math.min(4096,bytes.length-length),null);
      if (!bytesRead) break;
      length += bytesRead;
      if (bytes.subarray(0,length).includes(10)) break;
    }
    const text = bytes.subarray(0,length).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0 && length === bytes.length) throw new Error('INVALID_SESSION_HEADER');
    try { header = validateHeader(JSON.parse(end < 0 ? text : text.slice(0,end))); }
    catch { throw new Error('INVALID_SESSION_HEADER'); }
  } finally { await fd.close(); }
  let cwd = null;
  try {
    const resolved = await fs.realpath(header.cwd);
    if ((await fs.stat(resolved)).isDirectory()) cwd = resolved;
  } catch { /* Explicit session grants remain usable without a project directory. */ }
  return {header,file,id:opaqueId(`${file}\0${header.id}`),cwd};
}
export async function validateExecutionCwd(cwd) {
  try {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || await fs.realpath(cwd) !== cwd || !(await fs.stat(cwd)).isDirectory()) throw new Error();
  } catch { throw new Error('EXECUTION_CWD_UNAVAILABLE'); }
  return cwd;
}
export async function loadSession(file) {
  await assertSingleSessionFile(file);
  const digest = createHash('sha256'), entries = [], seen = new Set();
  let header, fragments = [];
  function parse(line) {
    if (!line.trim()) return;
    let entry;
    try { entry = JSON.parse(line); } catch { throw new Error('INVALID_SESSION'); }
    if (!header) { header = validateHeader(entry); return; }
    if (!entry || typeof entry.id !== 'string' || entry.id.length > 128 || seen.has(entry.id) || (entry.parentId != null && !seen.has(entry.parentId))) throw new Error('INVALID_SESSION_TREE');
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string')) throw new Error('INVALID_SESSION');
    seen.add(entry.id); entries.push(entry);
  }
  // LF only: Unicode line separators are valid inside JSON strings. Stream the
  // file so no second full transcript string/line array is retained in memory.
  for await (const chunk of createReadStream(file,{encoding:'utf8'})) {
    digest.update(chunk);
    let start = 0, end;
    while ((end = chunk.indexOf('\n',start)) !== -1) {
      fragments.push(chunk.slice(start,end)); parse(fragments.join(''));
      fragments = []; start = end + 1;
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
  }
  parse(fragments.join(''));
  if (!header) throw new Error('INVALID_SESSION');
  return {header,entries,leafId:entries.at(-1)?.id ?? null,revision:digest.digest('hex'),file};
}
export async function loadSavedSession(session) {
  const data = await loadSession(session.file);
  if (data.header.id !== session.header.id || data.header.cwd !== session.header.cwd) throw new Error('RUNTIME_SESSION_CHANGED');
  return {...session,...data};
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
          found.push(await readSessionIdentity(file));
        } catch { /* Invalid or partially written files are not exposed. */ }
      }
    }
  }
  for (const root of config.sessionRoots) await walk(root);
  return found.sort((a,b) => a.id.localeCompare(b.id));
}
function selectRecords(data, args) {
  let entries = data.entries;
  if (args.since) {
    if (args.view !== 'raw') throw new Error('SINCE_REQUIRES_RAW');
    const index = entries.findIndex(x => x.id === args.since);
    if (index < 0) throw new Error('ENTRY_NOT_FOUND');
    entries = entries.slice(index + 1);
  }
  let records, overview;
  if (args.view === 'raw') records = entries.map(e => ({ entry_id: e.id, entry: e }));
  else {
    if (args.leaf_id !== undefined && args.leaf_id !== null && !entries.some(e => e.id === args.leaf_id)) throw new Error('ENTRY_NOT_FOUND');
    const projection = buildSessionProjection(entries, args.leaf_id === undefined ? data.leafId : args.leaf_id);
    // Retained raw ranges can contain superseded checkpoints or context-hidden
    // summaries. Only entries contributing to this leaf's projection are active.
    if (args.view === 'overview') { records = overviewRecords(projection); overview = records[0]; }
    else if (args.view === 'summary') records = projection.entries.filter(e => e.messages.length > 0 && ['compaction','branch_summary'].includes(e.sourceEntry.type)).map(e => ({entry_id:e.sourceEntry.id, type:e.sourceEntry.type, summary:e.sourceEntry.summary}));
    else records = projection.entries.flatMap(e => e.messages.map((message, i) => ({entry_id:e.sourceEntry.id, message_index:i, message})));
  }
  if (args.entry_id) records = records.filter(e => e.entry_id === args.entry_id);
  if (args.query) records = records.filter(e => JSON.stringify(e).toLowerCase().includes(args.query.toLowerCase()));
  return {records,overview};
}
export function recordsFor(data,args) { return selectRecords(data,args).records; }
export function cursorSignature(args) {
  const view = args.view ?? 'context';
  return hash({session_id:args.session_id,view,entry_id:args.entry_id,since:args.since,query:args.query,leaf_id:args.leaf_id,
    ...(view==='overview'?{extractor:OVERVIEW_EXTRACTOR_VERSION}:{}),
    ...(hasTextSelector(args)?{message_index:args.message_index,block_index:args.block_index,text_offset:args.text_offset,field:args.field,section:args.section}:{})});
}
// Text cursors are distinct from the existing JSON-record cursors.
export function textCursor(args,revision,leaf,offset) {
  return Buffer.from(JSON.stringify({kind:'projected_text',signature:cursorSignature(args),revision,leaf_id:leaf,offset})).toString('base64url');
}
export const textBoundary=(text,offset)=>!(offset>0&&offset<text.length&&
  text.charCodeAt(offset-1)>=0xd800&&text.charCodeAt(offset-1)<=0xdbff&&
  text.charCodeAt(offset)>=0xdc00&&text.charCodeAt(offset)<=0xdfff);
export function fitDecodedText(text,maxChars,render) {
  let low=0,high=Math.min(text.length,maxChars);
  while(low<high){
    const mid=Math.ceil((low+high)/2),end=textBoundary(text,mid)?mid:mid-1;
    if(JSON.stringify(render(text.slice(0,end))).length<=maxChars)low=mid;else high=mid-1;
  }
  return textBoundary(text,low)?low:low-1;
}
export function textCursorOffset(args,revision,leaf) {
  if(!args.cursor)return args.text_offset??0;
  let cursor;try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new Error('INVALID_CURSOR');}
  if(!cursor||cursor.kind!=='projected_text'||cursor.signature!==cursorSignature(args)||cursor.revision!==revision||cursor.leaf_id!==leaf)throw new Error('STALE_CURSOR');
  if(!Number.isSafeInteger(cursor.offset)||cursor.offset<0)throw new Error('INVALID_CURSOR');
  return cursor.offset;
}
function pageProjectedText(records,args,revision,leaf) {
  const offset=textCursorOffset(args,revision,leaf);
  const row=records.find(record=>record.message_index===args.message_index);
  if(!row)throw new Error('PROJECTED_MESSAGE_NOT_FOUND');
  const field=args.field??'content';
  let text=row.message.content;
  if(field==='sections'){
    const sections=row.message.sections;
    if(row.message.role!=='system'||!sections||typeof sections!=='object'||Array.isArray(sections))throw new Error('NON_TEXT_CONTENT');
    if(!Object.hasOwn(sections,args.section))throw new Error('TEXT_SECTION_NOT_FOUND');
    text=sections[args.section];
    if(typeof text!=='string')throw new Error('NON_TEXT_CONTENT');
  }else if(args.block_index!==undefined){
    if(!Array.isArray(text))throw new Error('INVALID_TEXT_SELECTOR');
    const block=text[args.block_index];
    if(!block)throw new Error('TEXT_BLOCK_NOT_FOUND');
    if(block.type!=='text'||typeof block.text!=='string')throw new Error('NON_TEXT_CONTENT');
    text=block.text;
  }else if(typeof text!=='string')throw new Error('NON_TEXT_CONTENT');
  if(args.cursor&&offset>text.length)throw new Error('INVALID_CURSOR');
  if(offset>text.length||!textBoundary(text,offset))throw new Error('INVALID_TEXT_OFFSET');
  const item=value=>({entry_id:row.entry_id,message_index:row.message_index,field,
    ...(field==='sections'?{section:args.section}:{}),
    ...(args.block_index!==undefined?{block_index:args.block_index}:{}),
    text_offset:offset,total_text_units:text.length,text:value});
  const budget=Math.max(256,Math.min(args.max_chars??12000,32768)),remaining=text.slice(offset);
  const length=fitDecodedText(remaining,budget,item);
  if(JSON.stringify(item('')).length>budget||(remaining.length&&!length))throw new Error('TEXT_BUDGET_TOO_SMALL');
  return {format:'projected_text',offset_unit:'utf16_code_units',revision,leaf_id:leaf,
    items:[item(remaining.slice(0,length))],total_items:1,
    next_cursor:offset+length<text.length?textCursor(args,revision,leaf,offset+length):null};
}
// An older owner can ignore new selectors while still returning a successful
// ordinary read. Validate this request's shape/locator, not an owner version.
export function assertProjectedTextResponse(result,args) {
  if(!hasTextSelector(args))return;
  const reject=()=>{throw new Error('OWNER_READ_REFRESH_REQUIRED');};
  const item=result?.items?.[0],field=args.field??'content';
  if(result?.format!=='projected_text'||result.view!=='context'||result.offset_unit!=='utf16_code_units'||
    !Array.isArray(result.items)||result.items.length!==1||typeof result.revision!=='string'||!result.revision||
    !(result.leaf_id===null||typeof result.leaf_id==='string')||
    (args.leaf_id!==undefined&&result.leaf_id!==args.leaf_id)||
    item?.entry_id!==args.entry_id||item.message_index!==args.message_index||
    (item.field??'content')!==field||item.section!==args.section||item.block_index!==args.block_index||
    typeof item.text!=='string'||!Number.isSafeInteger(item.text_offset)||item.text_offset<0||
    !Number.isSafeInteger(item.total_text_units)||item.total_text_units<item.text_offset+item.text.length)reject();
  let offset=args.text_offset??0;
  if(args.cursor){
    let cursor;try{cursor=JSON.parse(Buffer.from(args.cursor,'base64url').toString());}catch{throw new Error('INVALID_CURSOR');}
    if(!cursor||cursor.kind!=='projected_text'||cursor.signature!==cursorSignature(args)||
      cursor.revision!==result.revision||cursor.leaf_id!==result.leaf_id)reject();
    offset=cursor.offset;
  }
  if(item.text_offset!==offset)reject();
  const end=offset+item.text.length;
  if(result.next_cursor===null){if(end!==item.total_text_units)reject();}
  else{
    let cursor;try{cursor=JSON.parse(Buffer.from(result.next_cursor,'base64url').toString());}catch{reject();}
    if(!cursor||cursor.kind!=='projected_text'||cursor.signature!==cursorSignature(args)||
      cursor.revision!==result.revision||cursor.leaf_id!==result.leaf_id||cursor.offset!==end||
      end>=item.total_text_units||!item.text.length)reject();
  }
}
// One selector and renderer for saved files, RPC snapshots and attachments.
export function renderRead(data,args,{leafSource='saved_resume',generation}={}) {
  const view=args.view??'context',leaf=view!=='raw'&&args.leaf_id!==undefined?args.leaf_id:
    (hasTextSelector(args)&&data.leafId===undefined?data.entries.at(-1)?.id??null:data.leafId);
  const textRead=hasTextSelector(args);
  if(textRead&&!readSchema.safeParse(args).success)throw new Error('INVALID_TEXT_SELECTOR');
  const selected=selectRecords(data,{...args,view});
  return {view,leaf_id:leaf,activity:data.activity??activityObservation(),...(generation===undefined?{}:{generation}),
    context_kind:['context','overview'].includes(view)?'pi_session_projection_not_final_provider_payload':undefined,
    ...(view==='overview'?{overview_scope:{...selected.overview,filter_scope:'selected_overview_records_only'},leaf_source:leafSource,leaf_selection:args.leaf_id===undefined?'current':'explicit',append_tail:data.entries.at(-1)?.id??null}:{}),
    ...(textRead?pageProjectedText(selected.records,{...args,view},data.revision,leaf):pageRecords(selected.records,{...args,view},data.revision))};
}
// Pagination also handles a single enormous record. No hidden truncation.
export function pageRecords(records, args, revision) {
  const signature = cursorSignature(args);
  let index = 0, offset = 0;
  if (args.cursor) {
    let c; try { c = JSON.parse(Buffer.from(args.cursor, 'base64url').toString()); } catch { throw new Error('INVALID_CURSOR'); }
    if (c.signature !== signature || c.revision !== revision) throw new Error('STALE_CURSOR');
    if (!Number.isSafeInteger(c.index) || c.index < 0 || !Number.isSafeInteger(c.offset) || c.offset < 0) throw new Error('INVALID_CURSOR');
    ({index, offset} = c);
  }
  const limit = Math.min(50, Math.max(1, args.limit ?? 20));
  const budget = Math.min(32768, Math.max(256, args.max_chars ?? 12000));
  let remaining = budget;
  const items = [];
  while (index < records.length && items.length < limit && remaining > 0) {
    const record = records[index];
    const encoded = JSON.stringify(record);
    if (offset > encoded.length) throw new Error('INVALID_CURSOR');
    // A normal record belongs intact on the next page. Only records larger
    // than a full page (or an existing fragment continuation) need splitting.
    if (offset === 0 && encoded.length <= budget && encoded.length > remaining) break;
    const amount = Math.min(remaining, encoded.length - offset);
    if (offset === 0 && amount === encoded.length) items.push(record);
    else items.push({entry_id:record.entry_id, json_fragment:encoded.slice(offset, offset + amount), char_offset:offset, total_chars:encoded.length});
    remaining -= amount; offset += amount;
    if (offset >= encoded.length) { index++; offset = 0; }
  }
  const next_cursor = index < records.length ? Buffer.from(JSON.stringify({signature,revision,index,offset})).toString('base64url') : null;
  return {items, next_cursor, revision, total_items:records.length};
}
