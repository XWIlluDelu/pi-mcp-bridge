import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { ifMissing, opaqueId } from './storage.mjs';
import { ownerAlive, processIdentity } from './process-identity.mjs';

const exec = promisify(execFile);
const occupied = new Set(['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR']);
let systemTemp;
let ownIdentity;

function missingLockEntry(error) {
  if (error.code === 'ENOTDIR') return null;
  return ifMissing(error);
}

async function legacyDirectories(dir) {
  if (dir) return [dir];
  const roots = ['/tmp', os.tmpdir()];
  if (process.platform === 'darwin') {
    // A service or child can omit TMPDIR while its predecessor has the login
    // environment. Cover both names even when the current environment differs.
    systemTemp ??= exec('/usr/bin/getconf', ['DARWIN_USER_TEMP_DIR'], { timeout: 3000 }).then(
      ({ stdout }) => {
        const root = stdout.trim();
        if (!path.isAbsolute(root)) throw new Error('INVALID_LOCK_DIRECTORY');
        return root;
      },
    );
    roots.push(await systemTemp);
  }
  return roots.map((root) => path.join(root, `pi-mcp-locks-${process.getuid()}`));
}

async function legacyAddress(dir, id) {
  // Darwin accepts up to 104 bytes. Older Node releases truncated the name
  // silently. Use exactly that on-disk name, even when part of the suffix fell off.
  const bytes = Buffer.from(path.join(dir, `${id}.sock`));
  if (104 - Buffer.byteLength(dir + path.sep + 'ps_') < 16) throw new Error('LOCK_PATH_TOO_LONG');
  const name = path.basename(bytes.subarray(0, 104).toString());
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077)
    throw new Error('INVALID_LOCK_DIRECTORY');
  return path.join(await fs.realpath(dir), name);
}

function removeEmptyLock(dir) {
  return fs.rmdir(dir).catch((error) => {
    if (!['ENOENT', 'ENOTDIR', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  });
}

async function reclaimFileLock(address) {
  const stat = await fs.lstat(address).catch(ifMissing);
  // An older live process and its stale socket have the same inode shape.
  // Leave old sockets in place. Old implementations can bind again at any time.
  if (!stat?.isDirectory() || stat.uid !== process.getuid() || stat.mode & 0o077) return false;
  const names = await fs.readdir(address).catch(missingLockEntry);
  if (!names) return true;
  if (names.length === 0) {
    await removeEmptyLock(address);
    return true;
  }
  const [name] = names;
  if (names.length !== 1 || !/^owner-[0-9a-f-]{36}$/.test(name)) return false;
  const file = path.join(address, name);
  const text = await fs.readFile(file, 'utf8').catch(missingLockEntry);
  if (!text) return true;
  const owner = JSON.parse(text);
  if (typeof owner?.start !== 'string' || typeof owner?.boot !== 'string') return false;
  if (await ownerAlive(owner)) return false;
  // Only the marker for this exact acquisition can be removed. If a successor
  // has published its directory, rmdir cannot remove its nonempty directory.
  await fs.unlink(file).catch(missingLockEntry);
  await removeEmptyLock(address);
  return true;
}

async function fileLock(address, owner, attempts, busy) {
  const pending = await fs.mkdtemp(path.join(path.dirname(address), 'pending-'));
  const marker = `owner-${randomUUID()}`;
  let acquired = false;
  try {
    await fs.writeFile(path.join(pending, marker), JSON.stringify(owner), { mode: 0o600 });
    let reaped = false;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        // A nonempty directory cannot be replaced by rename or by the old
        // socket cleanup's unlink. Publishing its process evidence is atomic.
        await fs.rename(pending, address);
        acquired = true;
        return async () => {
          await fs.unlink(path.join(address, marker));
          await removeEmptyLock(address);
        };
      } catch (error) {
        if (!occupied.has(error.code)) throw error;
        if (!reaped && (await reclaimFileLock(address))) {
          reaped = true;
          attempt--;
          continue;
        }
      }
      if (attempt + 1 < attempts) await delay(10);
    }
    throw new Error(busy);
  } finally {
    if (!acquired) await fs.rm(pending, { recursive: true, force: true });
  }
}

export async function kernelLock(
  namespace,
  { attempts = 1, busy = 'LOCK_BUSY', useFileLock = process.platform !== 'linux', dir } = {},
) {
  const id = opaqueId(namespace);
  if (useFileLock) {
    // Reserve the common short location first, then each previous location.
    // Only the former coordinates new contenders with different environments.
    const dirs = await legacyDirectories(dir);
    const addresses = [...new Set(await Promise.all(dirs.map((base) => legacyAddress(base, id))))];
    const owner = (ownIdentity ??= await processIdentity());
    if (!owner) throw new Error('PROCESS_IDENTITY_UNAVAILABLE');
    const unlock = [];
    const close = async () => {
      const failures = [];
      for (const release of unlock.reverse())
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      if (failures.length) throw new AggregateError(failures, 'Lock release failed');
    };
    try {
      for (const address of addresses) unlock.push(await fileLock(address, owner, attempts, busy));
      return { close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  for (let attempt = 0; attempt < attempts; attempt++) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await once(server.listen(`\0pi-mcp-${id}`), 'listening');
      return { close: promisify(server.close.bind(server)) };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (attempt + 1 < attempts) await delay(10);
    }
  }
  throw new Error(busy);
}
