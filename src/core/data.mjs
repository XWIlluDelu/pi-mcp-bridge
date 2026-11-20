import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { nativeSdk } from '../runtime/pi-installation.mjs';
import path from 'node:path';
import { sessionKey, assertNativeDirectory, NATIVE_TRASH_DIR } from './storage.mjs';
import { scanSavedLines } from './lf-lines.mjs';
// Cooperative storage boundary: reject aliases instead of changing public IDs.
// Checks do not exclude concurrent filesystem edits by the same Unix owner.
function sessionDirectory(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file)
    throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  return assertNativeDirectory(path.dirname(file));
}
function checkSessionStat(stat, { protectedPath }) {
  if (!stat.isFile() || stat.nlink !== 1) throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
  if (stat.uid !== process.getuid() || (!protectedPath && stat.mode & 0o022))
    throw new Error('UNSAFE_NATIVE_SESSION_STORAGE');
}
export async function assertSingleSessionFile(file, { allowMissing = false } = {}) {
  const directory = await sessionDirectory(file);
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw error;
  }
  checkSessionStat(stat, directory);
  return stat;
}

export async function withSessionFile(file, read, directory) {
  directory ??= await sessionDirectory(file);
  const fd = await fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error) => {
      if (error.code === 'ELOOP') throw new Error('SESSION_FILE_ALIAS_NOT_ALLOWED');
      throw error;
    });
  try {
    const stat = await fd.stat();
    checkSessionStat(stat, directory);
    return await read(fd, stat);
  } finally {
    await fd.close();
  }
}
function validateHeader(header) {
  if (
    header?.type !== 'session' ||
    typeof header.id !== 'string' ||
    !header.id ||
    header.id.length > 128 ||
    (header.cwd !== undefined &&
      header.cwd !== '' &&
      (typeof header.cwd !== 'string' || !path.isAbsolute(header.cwd) || header.cwd.includes('\0')))
  )
    throw new Error('INVALID_SESSION');
  return header;
}
// Identity discovery never parses transcript bodies. Bound the control header,
// independently of history size; keep an unavailable cwd separate from identity.
// A saved session keeps its identity while its canonical file, native ID and
// recorded cwd are unchanged; any change invalidates operations bound to it.
export function sameSessionIdentity(a, b) {
  return a.file === b.file && a.header.id === b.header.id && a.header.cwd === b.header.cwd;
}
// An owner reply names the native session it actually served.
export const servesSession = (reply, session) =>
  reply?.sessionFile === session.file && reply?.sessionId === session.header.id;
export function fileRevision(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
}
export function readSessionIdentity(file, directory) {
  return withSessionFile(
    file,
    async (fd, stat) => {
      const bytes = Buffer.allocUnsafe(65537);
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
        const newline = bytes.subarray(length, length + bytesRead).indexOf(10);
        length += newline < 0 ? bytesRead : newline;
        if (newline >= 0) break;
      }
      if (length === bytes.length) throw new Error('INVALID_SESSION_HEADER');
      let header;
      try {
        header = validateHeader(JSON.parse(bytes.toString('utf8', 0, length)));
      } catch {
        throw new Error('INVALID_SESSION_HEADER');
      }
      // Authorize against the recorded project, even after it goes offline.
      const cwd = header.cwd ? path.resolve(header.cwd) : null;
      return {
        header,
        file,
        id: sessionKey(file, header.id),
        cwd,
        mtimeMs: stat.mtime.getTime(),
        fileRevision: fileRevision(stat),
      };
    },
    directory,
  );
}
export async function validateExecutionCwd(cwd) {
  try {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error();
    const resolved = await fs.realpath(cwd);
    if (!(await fs.stat(resolved)).isDirectory()) throw new Error();
    return resolved;
  } catch {
    throw new Error('EXECUTION_CWD_UNAVAILABLE');
  }
}
export async function loadSession(file, { omitImageData = false, config, sdk } = {}) {
  const { parseSessionEntries, migrateSessionEntries, CURRENT_SESSION_VERSION } =
    sdk ?? (await nativeSdk(config));
  const records = [];
  let skipped = 0;
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
  const unterminated = await withSessionFile(file, async (fd, opened) => {
    // Native pure parsing skips malformed records; never call a loader which
    // repairs a missing LF or opens/migrates the user's file for writing.
    const tail = await scanSavedLines(
      fd.createReadStream({ encoding: 'utf8', autoClose: false }),
      parse,
    );
    const current = await assertSingleSessionFile(file);
    if (current.ino !== opened.ino || current.dev !== opened.dev)
      throw new Error('RUNTIME_SESSION_CHANGED');
    return tail;
  });
  validateHeader(records[0]);
  migrateSessionEntries(records);
  if (records[0].version !== CURRENT_SESSION_VERSION)
    throw new Error('UNSUPPORTED_SESSION_VERSION');
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
  return {
    header,
    entries,
    byId,
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
  if (!sameSessionIdentity(data, session)) throw new Error('RUNTIME_SESSION_CHANGED');
  return { ...session, ...data };
}
export async function discover(config) {
  const found = [];
  async function walk(dir, nested = false) {
    let directory;
    try {
      directory = await assertNativeDirectory(dir);
    } catch (error) {
      if (error.code === 'ENOENT' || (nested && error.message === 'UNSAFE_NATIVE_SESSION_STORAGE'))
        return;
      throw error;
    }
    // This traversal uses one validated parent for sibling files. Validate each
    // opened inode, and revalidate the directory on the next operation.
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      if (ent.name === NATIVE_TRASH_DIR) continue;
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) await walk(file, true);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          found.push(await readSessionIdentity(file, directory));
        } catch {
          /* Invalid or partially written files are not exposed. */
        }
      }
    }
  }
  for (const root of config.sessionRoots) await walk(root);
  return found.sort((a, b) => a.id.localeCompare(b.id));
}
const textBoundary = (text, offset) =>
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
