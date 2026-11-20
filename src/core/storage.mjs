// Filesystem primitives for configuration, ownership and native sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const NATIVE_TRASH_DIR = '.pi-mcp-trash';

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const opaqueId = (value) => `ps_${hash(value).slice(0, 32)}`;
// The public Bridge session ID: canonical file plus native session identity.
export const sessionKey = (file, nativeId) => opaqueId(`${file}\0${nativeId}`);
export async function atomicJson(file, value, { mode = 0o600, beforeRename, maxBytes } = {}) {
  let json = JSON.stringify(value, null, 2) + '\n';
  if (maxBytes !== undefined && Buffer.byteLength(json) > maxBytes) {
    json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxBytes) throw new Error('JSON_FILE_TOO_LARGE');
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'wx', mode);
  let published = false;
  try {
    try {
      await h.writeFile(json);
      await h.sync();
    } finally {
      await h.close();
    }
    if (beforeRename) await beforeRename();
    await fs.rename(tmp, file);
    published = true;
    await syncDir(path.dirname(file));
  } finally {
    // Only this invocation's unpublished file is temporary. A failed directory
    // sync must not undo the already-published record or mask the original error.
    if (!published) await fs.unlink(tmp).catch(() => {});
  }
}
export async function syncDir(dir) {
  const handle = await fs.open(dir, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Path integrity is shared by control and native storage. A private ancestor
// protects native umask descendants; a sticky ancestor such as /tmp protects
// owner-controlled entries, but an ordinary writable ancestor can replace them.
async function directoryIntegrity(dir, code) {
  const reject = () => {
    throw new Error(code);
  };
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir) reject();
  const components = dir.split(path.sep).filter(Boolean);
  let current = path.parse(dir).root,
    protectedPath = false,
    stat;
  for (let index = 0; index <= components.length; index++) {
    if (index) current = path.join(current, components[index - 1]);
    stat = await fs.lstat(current);
    const owned = stat.uid === process.getuid();
    if (!stat.isDirectory()) reject();
    if (!protectedPath) {
      if (!owned && stat.uid !== 0) reject();
      const stickyAncestor = index < components.length && Boolean(stat.mode & 0o1000);
      if (stat.mode & 0o022 && !stickyAncestor) reject();
      if (owned && !(stat.mode & 0o077)) protectedPath = true;
    }
    if (index === components.length && !owned) reject();
  }
  if ((await fs.realpath(dir)) !== dir) reject();
  return { stat, protectedPath };
}
export async function assertPrivateDirectory(
  dir,
  { code = 'STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY' } = {},
) {
  const { stat } = await directoryIntegrity(dir, code);
  if (stat.mode & 0o077) throw new Error(code);
}
export async function assertNativeDirectory(dir) {
  return directoryIntegrity(dir, 'UNSAFE_NATIVE_SESSION_STORAGE');
}
// Size the common read to the opened inode. If it grows, keep reading up to the
// caller's limit and probe one more byte so a truncated record is never accepted.
export async function readBoundedText(fd, size, limit, code) {
  if (size > limit) throw new Error(code);
  let buffer = Buffer.allocUnsafe(size + 1);
  let length = 0;
  for (;;) {
    const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
    if (!bytesRead) return buffer.toString('utf8', 0, length);
    length += bytesRead;
    if (length > limit) throw new Error(code);
    if (length === buffer.length) {
      const expanded = Buffer.allocUnsafe(limit + 1);
      buffer.copy(expanded);
      buffer = expanded;
    }
  }
}
export async function readPrivateFile(
  file,
  limit,
  {
    pathError = 'INVALID_PRIVATE_FILE',
    privacyError = pathError,
    allowGroupOtherRead = false,
    followSymlinks = false,
  } = {},
) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(pathError);
  const resolved = await fs.realpath(file);
  if (!followSymlinks && resolved !== file) throw new Error(pathError);
  const fd = await fs.open(
    resolved,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new Error(pathError);
    const forbidden = allowGroupOtherRead ? 0o022 : 0o077;
    if (stat.uid !== process.getuid() || stat.mode & forbidden) throw new Error(privacyError);
    return {
      text: await readBoundedText(fd, stat.size, limit, pathError),
      mode: stat.mode & 0o777,
      resolved,
    };
  } finally {
    await fd.close();
  }
}
