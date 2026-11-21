import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { opaqueId } from './storage.mjs';

async function isSocketAlive(socketPath) {
  return new Promise((resolve) => {
    const client = net.createConnection({ path: socketPath });
    const done = (alive) => {
      client.destroy();
      resolve(alive);
    };
    client.once('connect', () => done(true));
    client.once('error', (error) => done(!['ECONNREFUSED', 'ENOENT'].includes(error.code)));
  });
}

async function lockDir(customDir) {
  const dir = customDir ?? path.join(os.tmpdir(), `pi-mcp-locks-${process.getuid?.() ?? 'u'}`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
    throw new Error('INVALID_LOCK_DIRECTORY');
  return dir;
}

// Linux uses abstract Unix sockets (auto-released by kernel on crash).
// macOS and other POSIX systems use a private socket file with live-peer probing.
export async function kernelLock(
  namespace,
  { attempts = 1, busy = 'LOCK_BUSY', useFileSocket = process.platform !== 'linux', dir } = {},
) {
  const id = opaqueId(namespace);
  const address = useFileSocket ? path.join(await lockDir(dir), `${id}.sock`) : `\0pi-mcp-${id}`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await once(server.listen(address), 'listening');
      if (useFileSocket) await fs.chmod(address, 0o600).catch(() => {});
      const closeServer = promisify(server.close.bind(server));
      return {
        async close() {
          await closeServer();
          if (useFileSocket) await fs.unlink(address).catch(() => {});
        },
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (useFileSocket && !(await isSocketAlive(address))) {
        await fs.unlink(address).catch(() => {});
        // Retry immediately after reaping a dead process's stale socket.
        if (attempt === attempts - 1) attempt--;
        continue;
      }
      if (attempt + 1 < attempts) await delay(10);
    }
  }
  throw new Error(busy);
}
