import packageInfo from '../package.json' with { type: 'json' };
import net from 'node:net';
import fs from 'node:fs/promises';
import { prepareContextRead, READ_CONTRACT } from './context-read.mjs';
import { readLfLines } from './lf-lines.mjs';
import { publicError } from './errors.mjs';
import { nativeCompactReason } from './compact.mjs';

// Includes JSON escaping and envelope fields, not just prompt characters.
export const MAX_ATTACHMENT_REQUEST_BYTES = 8 * 1024 * 1024;
// Raw cooperative native snapshots are for fork, never a public read fallback.
export const MAX_ATTACHMENT_SNAPSHOT_BYTES = 32 * 1024 * 1024;

// The version slot identifies the endpoint to already-running owners of
// this wire format. Operations and replies define control compatibility.
export function ownerEnvelope({ generation, file, sessionId, bridgeVersion }, payload) {
  return (
    JSON.stringify({
      generation,
      file,
      sessionId,
      version: bridgeVersion ?? packageInfo.version,
      ...payload,
    }) + '\n'
  );
}

export function ownerServer(
  connections,
  binding,
  handle,
  failureCode = 'ATTACHED_OPERATION_FAILED',
) {
  return attachmentServer(connections, async (frame, socket) => {
    const record = binding();
    const reply = (payload, done) => socket.end(ownerEnvelope(record, payload), done);
    try {
      const request = JSON.parse(frame);
      if (
        request?.generation !== record.generation ||
        request.file !== record.file ||
        request.sessionId !== record.sessionId
      )
        throw new Error('RUNTIME_SESSION_CHANGED');
      if (typeof request.version !== 'string') throw new Error('ATTACHMENT_PROTOCOL_MISMATCH');
      const data = await handle(request, socket, reply, record);
      if (socket.writableEnded) return;
      const response = ownerEnvelope(record, { data });
      if (request.op === 'snapshot' && Buffer.byteLength(response) > MAX_ATTACHMENT_SNAPSHOT_BYTES)
        throw new Error('SESSION_TOO_LARGE');
      socket.end(response);
    } catch (error) {
      const native_reason = record.kind === 'rpc' && nativeCompactReason(error?.native_reason);
      reply({
        error: publicError(error, failureCode),
        ...(native_reason ? { native_reason } : {}),
      });
    }
  });
}

export const ownerIdentity = ({ file, sessionId }) => ({ sessionFile: file, sessionId });

export const pendingMessages = (state) =>
  Number.isSafeInteger(state.pendingMessageCount) && state.pendingMessageCount >= 0
    ? state.pendingMessageCount
    : null;

export const nativeBusy = (state) =>
  state.isIdle === false ||
  state.isBashRunning === true ||
  state.isStreaming === true ||
  state.isCompacting === true ||
  state.hasPendingMessages === true ||
  pendingMessages(state) > 0;

export function ownerReadFeatures(binding, features) {
  return { ...ownerIdentity(binding), contract: READ_CONTRACT, ...features };
}

export function ownerRead(binding, source, args, projection) {
  return { ...ownerIdentity(binding), ...prepareContextRead(source, args, projection) };
}

export const validNativeSnapshot = (snapshot) =>
  Array.isArray(snapshot?.entries) &&
  snapshot.entries.every((entry) => typeof entry?.id === 'string' && entry.id.length <= 128) &&
  (snapshot.leafId === null ||
    (typeof snapshot.leafId === 'string' && snapshot.leafId.length <= 128));

// Owner endpoints accept one newline-terminated JSON request per connection.
export function readRequest(socket, maxBytes, onRequest) {
  let bytes = 0;
  const bound = (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      lines.close();
      socket.destroy();
    }
  };
  socket.on('data', bound);
  const lines = readLfLines(socket, (line) => {
    socket.off('data', bound);
    lines.close();
    Promise.resolve(onRequest(line, socket)).catch(() => socket.destroy());
  });
  socket.once('close', lines.close);
}

export function attachmentServer(connections, onRequest) {
  return net.createServer((socket) => {
    if (connections.size >= 16) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setTimeout(5000, () => socket.destroy());
    socket.on('error', () => {});
    readRequest(socket, MAX_ATTACHMENT_REQUEST_BYTES, onRequest);
    socket.once('close', () => connections.delete(socket));
  });
}
export async function listenPrivate(server, socketPath) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await fs.chmod(socketPath, 0o600);
}
