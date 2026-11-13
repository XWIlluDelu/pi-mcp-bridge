import net from 'node:net';
import fs from 'node:fs/promises';

// Includes JSON escaping and envelope fields, not just prompt characters.
export const MAX_ATTACHMENT_REQUEST_BYTES = 8 * 1024 * 1024;
// Raw cooperative native snapshots are for fork, never a public read fallback.
export const MAX_ATTACHMENT_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// Owner endpoints (companion and host adapter) accept one newline-terminated
// JSON request per connection. Excess connections, oversized frames and idle
// peers are dropped without a reply; the handler owns the response.
export function attachmentServer(connections, onRequest) {
  return net.createServer((socket) => {
    if (connections.size >= 16) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => connections.delete(socket));
    let buffer = '';
    const read = (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_ATTACHMENT_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      socket.off('data', read);
      onRequest(buffer.slice(0, end), socket);
    };
    socket.on('data', read);
  });
}
export async function listenPrivate(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
}
