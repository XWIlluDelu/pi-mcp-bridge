import fs from 'node:fs/promises';
import { createReadStream, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { hash, opaqueId } from './storage.mjs';
// Cooperative storage boundary: reject aliases instead of changing public IDs.
// Checks do not exclude concurrent filesystem edits by the same Unix owner.
export async function assertSingleSessionFile(file, { allowMissing = false } = {}) {
  if (
    typeof file !== 'string' ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    (await fs.realpath(path.dirname(file))) !== path.dirname(file)
  )
    throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (await fs.realpath(file)) !== file
  )
    throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  return stat;
}
function validateHeader(header) {
  if (
    header?.type !== 'session' ||
    typeof header.id !== 'string' ||
    !header.id ||
    header.id.length > 128 ||
    !path.isAbsolute(header.cwd ?? '')
  )
    throw new Error('INVALID_SESSION');
  if (header.version !== 3) throw new Error('UNSUPPORTED_SESSION_VERSION');
  return header;
}
// Identity discovery never parses transcript bodies. Bound the control header,
// independently of history size; keep an unavailable cwd separate from identity.
export async function readSessionIdentity(file) {
  const expected = await assertSingleSessionFile(file);
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let header;
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== expected.ino ||
      opened.dev !== expected.dev
    )
      throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      // Most headers fit in one small read; extend only while looking for LF.
      const { bytesRead } = await fd.read(
        bytes,
        length,
        Math.min(4096, bytes.length - length),
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
      if (bytes.subarray(0, length).includes(10)) break;
    }
    const text = bytes.subarray(0, length).toString('utf8');
    const end = text.indexOf('\n');
    if (end < 0 && length === bytes.length) throw new Error('INVALID_SESSION_HEADER');
    try {
      header = validateHeader(JSON.parse(end < 0 ? text : text.slice(0, end)));
    } catch {
      throw new Error('INVALID_SESSION_HEADER');
    }
  } finally {
    await fd.close();
  }
  let cwd = null;
  try {
    const resolved = await fs.realpath(header.cwd);
    if ((await fs.stat(resolved)).isDirectory()) cwd = resolved;
  } catch {
    /* Explicit session grants remain usable without a project directory. */
  }
  return { header, file, id: opaqueId(`${file}\0${header.id}`), cwd };
}
export async function validateExecutionCwd(cwd) {
  try {
    if (
      typeof cwd !== 'string' ||
      !path.isAbsolute(cwd) ||
      (await fs.realpath(cwd)) !== cwd ||
      !(await fs.stat(cwd)).isDirectory()
    )
      throw new Error();
  } catch {
    throw new Error('EXECUTION_CWD_UNAVAILABLE');
  }
  return cwd;
}
export async function loadSession(file) {
  await assertSingleSessionFile(file);
  const digest = createHash('sha256'),
    entries = [],
    seen = new Set();
  let header,
    fragments = [];
  function parse(line) {
    if (!line.trim()) return;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error('INVALID_SESSION');
    }
    if (!header) {
      header = validateHeader(entry);
      return;
    }
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      entry.id.length > 128 ||
      seen.has(entry.id) ||
      (entry.parentId != null && !seen.has(entry.parentId))
    )
      throw new Error('INVALID_SESSION_TREE');
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string'))
      throw new Error('INVALID_SESSION');
    seen.add(entry.id);
    entries.push(entry);
  }
  // LF only: Unicode line separators are valid inside JSON strings. Stream the
  // file so no second full transcript string/line array is retained in memory.
  for await (const chunk of createReadStream(file, { encoding: 'utf8' })) {
    digest.update(chunk);
    let start = 0,
      end;
    while ((end = chunk.indexOf('\n', start)) !== -1) {
      fragments.push(chunk.slice(start, end));
      parse(fragments.join(''));
      fragments = [];
      start = end + 1;
    }
    if (start < chunk.length) fragments.push(chunk.slice(start));
  }
  parse(fragments.join(''));
  if (!header) throw new Error('INVALID_SESSION');
  return {
    header,
    entries,
    leafId: entries.at(-1)?.id ?? null,
    revision: digest.digest('hex'),
    file,
  };
}
export async function loadSavedSession(session) {
  const data = await loadSession(session.file);
  if (data.header.id !== session.header.id || data.header.cwd !== session.header.cwd)
    throw new Error('RUNTIME_SESSION_CHANGED');
  return { ...session, ...data };
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
        } catch {
          /* Invalid or partially written files are not exposed. */
        }
      }
    }
  }
  for (const root of config.sessionRoots) await walk(root);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
function cursorSignature({ session_id, operation, request_id }) {
  return hash({ session_id, operation, request_id });
}
// Receipt-output cursors bind the result and operation selector.
export function textCursor(args, revision, offset) {
  return Buffer.from(
    JSON.stringify({
      kind: 'control_output',
      signature: cursorSignature(args),
      revision,
      offset,
    }),
  ).toString('base64url');
}
export const textBoundary = (text, offset) =>
  !(
    offset > 0 &&
    offset < text.length &&
    text.charCodeAt(offset - 1) >= 0xd800 &&
    text.charCodeAt(offset - 1) <= 0xdbff &&
    text.charCodeAt(offset) >= 0xdc00 &&
    text.charCodeAt(offset) <= 0xdfff
  );
export function fitDecodedText(text, maxChars, render) {
  let low = 0,
    high = Math.min(text.length, maxChars);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      end = textBoundary(text, mid) ? mid : mid - 1;
    if (JSON.stringify(render(text.slice(0, end))).length <= maxChars) low = mid;
    else high = mid - 1;
  }
  return textBoundary(text, low) ? low : low - 1;
}
export function textCursorOffset(args, revision) {
  if (!args.cursor) return 0;
  let cursor;
  try {
    cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
  } catch {
    throw new Error('INVALID_CURSOR');
  }
  if (
    !cursor ||
    cursor.kind !== 'control_output' ||
    cursor.signature !== cursorSignature(args) ||
    cursor.revision !== revision
  )
    throw new Error('STALE_CURSOR');
  if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error('INVALID_CURSOR');
  return cursor.offset;
}
