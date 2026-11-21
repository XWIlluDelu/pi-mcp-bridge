import packageInfo from '../../package.json' with { type: 'json' };
import net from 'node:net';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { prepareContextRead, READ_CONTRACT } from '../read/context-read.mjs';
import { ContextObservation } from '../read/context-observation.mjs';
import { LiveMessageObserver } from '../read/live-message.mjs';
import { nativeReadFeatures } from '../read/read-features.mjs';
import { SettledObserver } from '../events/settled-observer.mjs';
import { readLfLines } from '../core/lf-lines.mjs';
import { publicError } from '../core/errors.mjs';
import { nativeCompactReason } from '../ops/compact.mjs';

// Includes JSON escaping and envelope fields, not just prompt characters.
export const MAX_ATTACHMENT_REQUEST_BYTES = 8 * 1024 * 1024;
// Raw cooperative native snapshots are for fork, never a public read fallback.
export const MAX_ATTACHMENT_SNAPSHOT_BYTES = 32 * 1024 * 1024;
export const ownerProtocol = Object.freeze({
  bridgeVersion: packageInfo.version,
  readContract: READ_CONTRACT,
});

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

export function ownerServer(binding, handle, failureCode = 'ATTACHED_OPERATION_FAILED') {
  const connections = new Set();
  const server = attachmentServer(connections, async (frame, socket) => {
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
  return {
    listen: (socketPath) => listenPrivate(server, socketPath),
    // Keep the current release connection open for its acknowledgment.
    stopAccepting: () => server.close(() => {}),
    close: async () => {
      for (const socket of connections) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export const ownerIdentity = ({ file, sessionId }) => ({ sessionFile: file, sessionId });

export const unconfirmedPrompt = () => ({
  status: 'unknown',
  reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
});

// Pi extension and SDK calls attest dispatch only. Entering the prompt handler
// can have side effects before a throw.
export function dispatchPromptWithoutAck(run, onError) {
  try {
    run();
    return { status: 'dispatched', admission: 'unobservable' };
  } catch (error) {
    try {
      onError?.(error);
    } catch {}
    return unconfirmedPrompt();
  }
}

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

export const nativeSnapshot = (manager) => ({
  entries: manager.getEntries(),
  leafId: manager.getLeafId(),
});

function summarizeCommands(commands) {
  if (!Array.isArray(commands)) return undefined;
  return commands
    .filter((cmd) => typeof cmd?.name === 'string' && cmd.name.length <= 128)
    .slice(0, 128)
    .map((cmd) => ({
      name: cmd.name,
      ...(typeof cmd.source === 'string' ? { source: cmd.source.slice(0, 32) } : {}),
      ...(typeof cmd.description === 'string' && cmd.description
        ? { description: cmd.description.slice(0, 160) }
        : {}),
    }));
}

export function nativeOwnerRead(pi, binding, request, ctx, observers, buildSessionProjection) {
  const manager = ctx.sessionManager;
  if (request.op === 'read_features')
    return ownerReadFeatures(
      binding,
      nativeReadFeatures(pi.getAllTools(), pi.getCommands(), manager.getLeafId()),
    );
  const body = request.body ?? {};
  if (body.view === 'runtime')
    return { ...ownerIdentity(binding), ...observers.observation.read(body, ctx) };
  const result = ownerRead(
    binding,
    { ...nativeSnapshot(manager), live: observers.liveMessage.snapshot() },
    body,
    { buildSessionProjection, readAdapters: request.readAdapters },
  );
  if (body.content?.system === true && typeof pi.getCommands === 'function') {
    const commands = summarizeCommands(pi.getCommands());
    if (commands?.length) result.commands = commands;
  }
  return result;
}

export function nativeOwnerObservers(source, generation, control, lifecycle) {
  return {
    liveMessage: new LiveMessageObserver(source),
    observation: new ContextObservation(generation, lifecycle),
    settled: control && new SettledObserver(control, generation, lifecycle),
  };
}

export function observeNativeOwner(pi, current, validateSettled) {
  for (const name of ['message_start', 'message_update', 'message_end'])
    pi.on(name, (event) => current()?.liveMessage.update(event));
  // Capture follows native context transforms regardless of extension order.
  pi.on('context_with_system', (event, ctx) => current()?.observation.capture(event, ctx));
  pi.on('agent_start', (_event, ctx) => current(ctx)?.settled?.start(ctx.sessionManager));
  pi.on('agent_settled', async (event, ctx) => {
    const observers = current(ctx);
    if (!observers) return;
    // Freeze the native result before storage validation or local IPC.
    observers.liveMessage.reset();
    const occurrence = observers.settled?.capture(event, ctx.sessionManager);
    if (validateSettled) await validateSettled(observers);
    if (occurrence) await observers.settled.send(occurrence);
  });
}

export const validNativeSnapshot = (snapshot) =>
  Array.isArray(snapshot?.entries) &&
  snapshot.entries.every((entry) => typeof entry?.id === 'string' && entry.id.length <= 128) &&
  (snapshot.leafId === null ||
    (typeof snapshot.leafId === 'string' && snapshot.leafId.length <= 128));

// Owner endpoints accept one newline-terminated JSON request per connection.
export function readRequest(socket, maxBytes, onRequest) {
  const lines = readLfLines(
    socket,
    (line) => {
      lines.close();
      Promise.resolve(onRequest(line, socket)).catch(() => socket.destroy());
    },
    {
      maxBytes: maxBytes - 1,
      onOverflow: () => {
        lines.close();
        socket.destroy();
      },
    },
  );
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
  await once(server.listen(socketPath), 'listening');
  await fs.chmod(socketPath, 0o600);
}
