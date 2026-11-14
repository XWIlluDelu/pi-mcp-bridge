// Public Pi context observation for a Bridge-owned child. Never owns a claim.
import { ownerRequest } from './owner-runtime.mjs';
import { opaqueId } from './storage.mjs';
// Pi's extension loader supplies its own public exports, including the actual
// CLI class in bundled installations. Importing sdkEntry separately would not.
import * as sdk from '@earendil-works/pi-coding-agent';
import { reloadAdmission } from './reload-admission.mjs';
import { ContextObservation } from './context-observation.mjs';
import { nativeReadFeatures } from './read-features.mjs';
import { LiveMessageObserver } from './live-message.mjs';
import { SettledObserver } from './settled-observer.mjs';
import {
  attachmentServer,
  listenPrivate,
  ownerEnvelope,
  parseOwnerRequest,
  ownerIdentity,
  ownerReadFeatures,
  ownerRead,
} from './attachment-protocol.mjs';
import { parseCompactInput, compactMetadata, nativeCompactReason } from './compact.mjs';
import { publicError } from './errors.mjs';
export default async function rpcObserver(pi) {
  const value = process.env.PI_MCP_RPC_OBSERVER;
  if (!value) return;
  const { socket, generation, ownerControl } = JSON.parse(value);
  const admission = reloadAdmission(sdk.AgentSession);
  let server, context;
  const connections = new Set();
  const live = new LiveMessageObserver('rpc_message_events');
  for (const name of [
    'agent_start',
    'agent_settled',
    'message_start',
    'message_update',
    'message_end',
  ])
    pi.on(name, (event) => live.update(event));
  // Preserve observation/completion ordering across native extension reload.
  const key = Symbol.for('pi-mcp-bridge.rpc-observer.lifecycle');
  const lifecycle =
    globalThis[key]?.generation === generation
      ? globalThis[key]
      : (globalThis[key] = {
          generation,
          captureSequence: 0,
          completionSequence: 0,
        });
  // Capture the native boundary before the first await. Only local IPC is
  // acknowledged here; HTTPS delivery never blocks Pi or keeps its writer alive.
  if (ownerControl) {
    const settled = new SettledObserver(ownerControl, generation, lifecycle);
    pi.on('agent_start', (_event, ctx) => settled.start(ctx.sessionManager));
    pi.on('agent_settled', (event, ctx) => {
      const occurrence = settled.capture(event, ctx.sessionManager);
      return settled.send(occurrence);
    });
  }
  // Preserve capture ordering across reload within this same owner generation.
  const observation = new ContextObservation(generation, lifecycle);
  // Pi dispatches every context handler before this phase, irrespective of
  // extension load order. Later full-context hooks can still change it.
  pi.on('context_with_system', (event, ctx) => observation.capture(event, ctx));
  // An owned RPC is one file-bound writer. Veto before Pi opens another file;
  // session_shutdown is too late. Native TUI/host owners use their own lifecycle.
  pi.on('session_before_switch', (event, ctx) => {
    if (
      event.reason !== 'resume' ||
      event.targetSessionFile !== ctx.sessionManager.getSessionFile()
    )
      return { cancel: true };
  });
  pi.on('session_before_fork', () => ({ cancel: true }));
  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    admission.setOnIdle(ctx.sessionManager, () => {
      if (ownerControl)
        void ownerRequest(
          ownerControl,
          {
            op: 'idle_candidate',
            session_id: opaqueId(
              ctx.sessionManager.getSessionFile() + '\0' + ctx.sessionManager.getSessionId(),
            ),
            generation,
          },
          { signal: AbortSignal.timeout(2000) },
        ).catch(() => {});
    });
    observation.reset();
    if (server) return;
    server = attachmentServer(connections, async (frame, connection) => {
      let result, request;
      const binding = {
        generation,
        file: context?.sessionManager.getSessionFile(),
        sessionId: context?.sessionManager.getSessionId(),
      };
      try {
        request = parseOwnerRequest(frame, (request) => {
          if (
            !context ||
            !['state', 'read', 'read_features', 'seal', 'compact'].includes(request.op) ||
            request.generation !== binding.generation ||
            request.file !== binding.file ||
            request.sessionId !== binding.sessionId
          )
            throw new Error('RUNTIME_SESSION_CHANGED');
        });
        if (request.op === 'compact') {
          const input = parseCompactInput(request.body);
          if (input.interrupt) throw new Error('INVALID_ARGUMENTS');
          const value = await admission.compact(context.sessionManager, context, () => {
            connection.setTimeout(0);
            return new Promise((resolve, reject) =>
              context.compact({
                customInstructions: input.instructions,
                onComplete: resolve,
                onError: (error) =>
                  reject(
                    Object.assign(new Error('PI_REJECTED'), {
                      native_reason: nativeCompactReason(error.message),
                    }),
                  ),
              }),
            );
          });
          result = { data: compactMetadata(value) };
        } else if (request.op === 'seal') {
          if (
            !request.body ||
            typeof request.body !== 'object' ||
            Array.isArray(request.body) ||
            Object.keys(request.body).length
          )
            throw new Error('INVALID_ARGUMENTS');
          const sealed = admission.seal(context.sessionManager, context);
          result = { data: sealed ? { sealed: true } : { sealed: false, reason: 'busy' } };
        } else if (request.op === 'state') {
          result = {
            data: {
              isIdle: context.isIdle() && admission.idle(context.sessionManager),
              hasPendingMessages: context.hasPendingMessages(),
              sealed: admission.sealed(context.sessionManager),
            },
          };
        } else if (request.op === 'read_features') {
          result = {
            data: ownerReadFeatures(
              binding,
              nativeReadFeatures(
                pi.getAllTools(),
                pi.getCommands(),
                context.sessionManager.getLeafId(),
              ),
            ),
          };
        } else if (request.body?.view === 'runtime') {
          result = {
            data: { ...ownerIdentity(binding), ...observation.read(request.body, context) },
          };
        } else {
          result = {
            data: ownerRead(
              binding,
              {
                entries: context.sessionManager.getEntries(),
                leafId: context.sessionManager.getLeafId(),
                live: live.snapshot(),
              },
              request.body,
              { ...sdk, readAdapters: request.readAdapters },
            ),
          };
        }
      } catch (error) {
        result =
          request?.op === 'compact'
            ? {
                error: publicError(error),
                ...(error.native_reason ? { native_reason: error.native_reason } : {}),
              }
            : { error: error.message };
      }
      connection.end(ownerEnvelope(binding, result));
    });
    await listenPrivate(server, socket);
  });
  pi.on('session_shutdown', async () => {
    if (context) admission.setOnIdle(context.sessionManager, undefined);
    context = null;
    live.reset();
    observation.reset();
    // Reload/replacement recreates factories after shutdown handlers finish.
    // Close the owning listener (which unlinks its Unix socket) before rebinding.
    for (const connection of connections) connection.destroy();
    const listener = server;
    server = undefined;
    if (listener) await new Promise((resolve) => listener.close(resolve));
  });
}
