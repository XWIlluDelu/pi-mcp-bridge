import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { opaqueId } from './storage.mjs';

// Linux abstract sockets are process-owned: crashes release the mutex without
// stale-file recovery. Namespaces separate service, policy edits and registry.
export async function kernelLock(namespace, { attempts = 1, busy = 'LOCK_BUSY' } = {}) {
  const address = '\0pi-mcp-' + opaqueId(namespace);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await once(server.listen(address), 'listening');
      return { close: promisify(server.close.bind(server)) };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (attempt + 1 < attempts) await delay(10);
    }
  }
  throw new Error(busy);
}
