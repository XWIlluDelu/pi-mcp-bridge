import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { nativeSdk } from './pi-installation.mjs';
import path from 'node:path';
import { hash, opaqueId, assertNativeDirectory } from './storage.mjs';
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
  const { protectedPath } = await assertNativeDirectory(path.dirname(file));
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
  if (stat.uid !== process.getuid() || (!protectedPath && stat.mode & 0o022))
    throw new Error('UNSAFE_NATIVE_SESSION_STORAGE');
  return stat;
}
function validateHeader(header) {
  if (
    header?.type !== 'session' ||
    typeof header.id !== 'string' ||
    !header.id ||
    header.id.length > 128 ||
    (header.cwd !== undefined &&
      header.cwd !== '' &&
      (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd)))
  )
    throw new Error('INVALID_SESSION');
  if (![1, 2, 3].includes(header.version ?? 1)) throw new Error('UNSUPPORTED_SESSION_VERSION');
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
  if (header.cwd) {
    try {
      const resolved = await fs.realpath(header.cwd);
      if ((await fs.stat(resolved)).isDirectory()) cwd = resolved;
    } catch {
      /* Explicit session grants remain usable without a project directory. */
    }
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
export async function loadSession(file, { omitImageData = false, config } = {}) {
  const { parseSessionEntries, migrateSessionEntries } = await nativeSdk(config);
  const expected = await assertSingleSessionFile(file),
    fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    records = [];
  let fragments = [],
    skipped = 0,
    unterminated = false;
  const parse = (line) => {
    if (!line.trim()) return;
    const parsed = parseSessionEntries(line);
    if (!parsed.length) skipped++;
    else
      for (const entry of parsed) {
        if (omitImageData) {
          // Rendering never uses native image bytes. Drop only content-block data,
          // not business details/arguments; raw fork snapshots keep their default.
          const content =
            entry.type === 'message'
              ? entry.message?.content
              : entry.type === 'custom_message'
                ? entry.content
                : null;
          for (const block of Array.isArray(content) ? content : [])
            if (block?.type === 'image') delete block.data;
        }
        records.push(entry);
      }
  };
  try {
    const opened = await fd.stat();
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.ino !== expected.ino ||
      opened.dev !== expected.dev
    )
      throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
    // Native pure parsing skips malformed records; never call a loader which
    // repairs a missing LF or opens/migrates the user's file for writing.
    for await (const chunk of fd.createReadStream({ encoding: 'utf8', autoClose: false })) {
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
    const tail = fragments.join('');
    unterminated = Boolean(tail);
    parse(tail);
    const current = await assertSingleSessionFile(file);
    if (current.ino !== opened.ino || current.dev !== opened.dev)
      throw new Error('RUNTIME_SESSION_CHANGED');
  } finally {
    await fd.close();
  }
  validateHeader(records[0]);
  migrateSessionEntries(records);
  const [header, ...entries] = records,
    byId = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.id !== 'string' ||
      entry.id.length > 128 ||
      byId.has(entry.id) ||
      (entry.parentId != null && typeof entry.parentId !== 'string')
    )
      throw new Error('INVALID_SESSION_TREE');
    if (entry.type === 'message' && (!entry.message || typeof entry.message.role !== 'string'))
      throw new Error('INVALID_SESSION');
    byId.set(entry.id, entry);
  }
  sessionEntryIndex(entries, entries.at(-1)?.id ?? null, byId);
  return {
    header,
    entries,
    leafId: entries.at(-1)?.id ?? null,
    file,
    ...(skipped || unterminated
      ? {
          history: { skipped_malformed_lines: skipped, unterminated_tail: unterminated },
        }
      : {}),
  };
}
// Native projection and getBranch follow parent links without a cycle guard.
// Check only the requested path, not abandoned branches or missing parents.
export function sessionEntryIndex(entries, leafId, byId) {
  if (!byId) {
    byId = new Map();
    for (const entry of entries) byId.set(entry.id, entry);
  }
  const visited = new Set();
  for (let entry = byId.get(leafId); entry; entry = byId.get(entry.parentId)) {
    if (visited.has(entry.id)) throw new Error('INVALID_SESSION_TREE');
    visited.add(entry.id);
  }
  return byId;
}
export async function loadSavedSession(session, options) {
  const data = await loadSession(session.file, options);
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
  for (const root of config.sessionRoots) {
    try {
      await assertNativeDirectory(root);
    } catch (error) {
      if (error.code === 'ENOENT') continue; // An unused root need not exist yet.
      throw error;
    }
    await walk(root);
  }
  return found.sort((a, b) => a.id.localeCompare(b.id));
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
export function fitDecodedText(text, maxChars, render, fits = () => true) {
  let low = 0,
    high = Math.min(text.length, maxChars);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2),
      end = textBoundary(text, mid) ? mid : mid - 1;
    const value = render(text.slice(0, end));
    if (JSON.stringify(value).length <= maxChars && fits(value)) low = mid;
    else high = mid - 1;
  }
  return textBoundary(text, low) ? low : low - 1;
}
