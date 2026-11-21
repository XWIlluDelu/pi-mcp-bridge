// Filesystem primitives for configuration, ownership and native sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const NATIVE_TRASH_DIR = '.pi-mcp-trash';

export function ifMissing(error) {
  if (error.code !== 'ENOENT') throw error;
  return null;
}

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const opaqueId = (value) => `ps_${hash(value).slice(0, 32)}`;
// The public Bridge session ID: canonical file plus native session identity.
export const sessionKey = (file, nativeId) => opaqueId(`${file}\0${nativeId}`);
// Own cleanup only after the exclusive open succeeds. A failed write or fsync
// must leave neither a partial record nor an unlink of someone else's file.
export async function writeNewFile(file, data, { mode = 0o600, io = fs } = {}) {
  const handle = await io.open(file, 'wx', mode);
  try {
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await io.unlink(file).catch(() => {});
    throw error;
  }
}
export async function atomicJson(file, value, { mode = 0o600, beforeRename, maxBytes } = {}) {
  let json = JSON.stringify(value, null, 2) + '\n';
  if (maxBytes !== undefined && Buffer.byteLength(json) > maxBytes) {
    json = JSON.stringify(value);
    if (Buffer.byteLength(json) > maxBytes) throw new Error('JSON_FILE_TOO_LARGE');
  }
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeNewFile(tmp, json, { mode });
  try {
    await beforeRename?.();
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => {});
    throw error;
  }
  await syncDir(path.dirname(file));
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
async function directoryIntegrity(dir, code, requirePrivate = false) {
  const reject = () => {
    throw new Error(code);
  };
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || path.resolve(dir) !== dir) reject();
  const components = dir.split(path.sep).filter(Boolean);
  let current = path.parse(dir).root,
    protectedPath = false;
  for (let index = 0; index <= components.length; index++) {
    if (index) current = path.join(current, components[index - 1]);
    const stat = await fs.lstat(current);
    const owned = stat.uid === process.getuid();
    const leaf = index === components.length;
    if (!stat.isDirectory()) reject();
    if (!protectedPath) {
      if (!owned && stat.uid !== 0) reject();
      const stickyAncestor = !leaf && Boolean(stat.mode & 0o1000);
      if (stat.mode & 0o022 && !stickyAncestor) reject();
      if (owned && !(stat.mode & 0o077)) protectedPath = true;
    }
    if (leaf && (!owned || (requirePrivate && stat.mode & 0o077))) reject();
  }
  if ((await fs.realpath(dir)) !== dir) reject();
  return protectedPath;
}
export async function assertPrivateDirectory(
  dir,
  { code = 'STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY' } = {},
) {
  await directoryIntegrity(dir, code, true);
}
export function assertNativeDirectory(dir) {
  return directoryIntegrity(dir, 'UNSAFE_NATIVE_SESSION_STORAGE');
}
export async function readBoundedBytes(stream, limit, overflowError) {
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > limit) throw overflowError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length);
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
  return {
    ...(await readPrivateInode(resolved, limit, { pathError, privacyError, allowGroupOtherRead })),
    resolved,
  };
}

export async function withReadInode(file, read, aliasError) {
  const fd = await fs
    .open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error) => {
      if (aliasError && error.code === 'ELOOP') throw new Error(aliasError);
      throw error;
    });
  try {
    return await read(fd, await fd.stat());
  } finally {
    await fd.close();
  }
}

// The registry already checked the parent directory. Open the supplied entry
// directly so even a dangling symlink is an invalid claim, never a missing one.
export async function readPrivateInode(
  file,
  limit,
  {
    pathError = 'INVALID_PRIVATE_FILE',
    privacyError = pathError,
    allowGroupOtherRead = false,
  } = {},
) {
  return withReadInode(file, async (fd, stat) => {
    if (!stat.isFile()) throw new Error(pathError);
    const forbidden = allowGroupOtherRead ? 0o022 : 0o077;
    if (stat.uid !== process.getuid() || stat.mode & forbidden) throw new Error(privacyError);
    if (stat.size > limit) throw new Error(pathError);
    // Probe one byte past the limit in case the opened file grew after stat.
    const input = fd.createReadStream({ start: 0, end: limit, autoClose: false });
    const bytes = await readBoundedBytes(input, limit, () => new Error(pathError));
    return { text: bytes.toString('utf8'), mode: stat.mode & 0o777 };
  });
}
