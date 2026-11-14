import packageInfo from '../package.json' with { type: 'json' };
import net from 'node:net';
import fs from 'node:fs/promises';
import { prepareContextRead, READ_CONTRACT } from './context-read.mjs';

// Includes JSON escaping and envelope fields, not just prompt characters.
export const MAX_ATTACHMENT_REQUEST_BYTES = 8 * 1024 * 1024;
// Raw cooperative native snapshots are for fork, never a public read fallback.
export const MAX_ATTACHMENT_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// Read snapshots have their own contract. State and reload also provide the
// identity/recovery path for refreshing a live owner at a safe boundary.
export const requiresCurrentControl = (op) =>
  !['state', 'read', 'read_features', 'reload'].includes(op);

export function ownerEnvelope({ generation, file, sessionId }, payload) {
  return (
    JSON.stringify({ generation, file, sessionId, version: packageInfo.version, ...payload }) + '\n'
  );
}

export function parseOwnerRequest(frame, checkIdentity) {
  const request = JSON.parse(frame);
  checkIdentity(request);
  if (requiresCurrentControl(request.op) && request.version !== packageInfo.version)
    throw new Error('OWNER_COMPONENT_UPDATE_REQUIRED');
  return request;
}

export const ownerIdentity = ({ file, sessionId }) => ({ sessionFile: file, sessionId });

export function attachedActivity(state) {
  const idle = state.activity?.idle ?? state.isIdle;
  const busy =
    idle === false ||
    state.activity?.pending_messages === true ||
    state.hasPendingMessages === true ||
    state.isBashRunning === true ||
    state.isStreaming === true ||
    state.isCompacting === true ||
    (Number.isSafeInteger(state.pendingMessageCount) && state.pendingMessageCount > 0);
  return { state, status: busy ? 'busy' : idle === true ? 'idle' : 'unknown' };
}

export function ownerReadFeatures(binding, features) {
  return { ...ownerIdentity(binding), contract: READ_CONTRACT, ...features };
}

export function ownerRead(binding, source, args, projection) {
  return { ...ownerIdentity(binding), ...prepareContextRead(source, args, projection) };
}

export function ownerSnapshot(binding, { entries, leafId }) {
  const data = { ...ownerIdentity(binding), entries, leafId };
  if (Buffer.byteLength(JSON.stringify(data)) > MAX_ATTACHMENT_SNAPSHOT_BYTES)
    throw new Error('SESSION_TOO_LARGE');
  return data;
}

// Owner endpoints accept one newline-terminated
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
      Promise.resolve(onRequest(buffer.slice(0, end), socket)).catch(() => socket.destroy());
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
