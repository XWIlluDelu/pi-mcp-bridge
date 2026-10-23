// Filesystem primitives for configuration, ownership and native sessions.
import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export const hash = (value) =>
  createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
export const opaqueId = (value) => `ps_${hash(value).slice(0, 32)}`;
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'wx', 0o600);
  let published = false;
  try {
    try {
      await h.writeFile(JSON.stringify(value, null, 2));
      await h.sync();
    } finally {
      await h.close();
    }
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
async function directoryIntegrity(dir, { allowMissing = false, code } = {}) {
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
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return { protectedPath };
      throw error;
    }
    const owned = stat.uid === process.getuid();
    if (!stat.isDirectory() || stat.isSymbolicLink()) reject();
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
  { allowMissing = false, code = 'STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY' } = {},
) {
  const { stat } = await directoryIntegrity(dir, { allowMissing, code });
  if (stat && stat.mode & 0o077) throw new Error(code);
}
export async function assertNativeDirectory(dir) {
  return directoryIntegrity(dir, { code: 'UNSAFE_NATIVE_SESSION_STORAGE' });
}
export async function readPrivateFile(
  file,
  limit,
  { pathError = 'INVALID_PRIVATE_FILE', privacyError = pathError } = {},
) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || (await fs.realpath(file)) !== file)
    throw new Error(pathError);
  const fd = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > limit) throw new Error(pathError);
    if (stat.uid !== process.getuid() || stat.mode & 0o077) throw new Error(privacyError);
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await fd.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) throw new Error(pathError);
    return { text: buffer.subarray(0, length).toString('utf8'), mode: stat.mode & 0o777 };
  } finally {
    await fd.close();
  }
}
