import net from 'node:net';
import { opaqueId } from './storage.mjs';

// Linux abstract sockets are process-owned: crashes release the mutex without
// stale-file recovery. Namespaces separate service, policy edits and registry.
export async function kernelLock(namespace, { attempts = 1, busy = 'LOCK_BUSY' } = {}) {
  const address = '\0pi-mcp-' + opaqueId(namespace);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const server = net.createServer((socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(address, resolve);
      });
      return {
        close: () =>
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(busy);
}
