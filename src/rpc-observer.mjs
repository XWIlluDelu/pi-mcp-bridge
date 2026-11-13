// Public Pi context observation for a Bridge-owned child. Never owns a claim.
import net from 'node:net';
import { ownerRequest } from './owner-runtime.mjs';
import { opaqueId } from './storage.mjs';
// Pi's extension loader supplies its own public exports, including the actual
// CLI class in bundled installations. Importing sdkEntry separately would not.
import * as sdk from '@earendil-works/pi-coding-agent';
import { observeRpcInputs } from './rpc-input-activity.mjs';
import { reloadAdmission } from './reload-admission.mjs';
import packageInfo from '../package.json' with { type: 'json' };
import fs from 'node:fs/promises';
import { prepareContextRead, READ_CONTRACT } from './context-read.mjs';
import { ContextObservation } from './context-observation.mjs';
import { nativeReadFeatures } from './read-features.mjs';
import { LiveMessageObserver } from './live-message.mjs';
import { SettledObserver } from './settled-observer.mjs';
import { MAX_ATTACHMENT_REQUEST_BYTES } from './attachment-protocol.mjs';
import { compactInputSchema, compactMetadata, nativeCompactReason } from './compact.mjs';
import { publicError } from './errors.mjs';
export default async function rpcObserver(pi) {
  const value = process.env.PI_MCP_RPC_OBSERVER;
  if (!value) return;
  const { socket, generation, ownerControl } = JSON.parse(value);
  const admission = reloadAdmission(sdk.AgentSession);
  // Reuse owner-local IPC; Pi reserves stdout for its own RPC records.
  // Sequence numbers preserve ordering across concurrent notifications/reload.
  const inputActivity = observeRpcInputs(sdk.AgentSession, (manager, activity) => {
    if (ownerControl)
      void ownerRequest(
        ownerControl,
        {
          op: 'input_activity',
          session_id: opaqueId(manager.getSessionFile() + '\0' + manager.getSessionId()),
          generation,
          ...activity,
        },
        { signal: AbortSignal.timeout(2000) },
      ).catch(() => {}); // A later idle check can read authoritative child state.
  });
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
    server = net.createServer((connection) => {
      connections.add(connection);
      let body = '',
        handled = false;
      connection.setEncoding('utf8');
      connection.setTimeout(5000, () => connection.destroy());
      connection.on('error', () => {});
      connection.on('close', () => connections.delete(connection));
      connection.on('data', async (chunk) => {
        if (handled) return;
        body += chunk;
        if (Buffer.byteLength(body) > MAX_ATTACHMENT_REQUEST_BYTES) {
          connection.destroy();
          return;
        }
        if (!body.includes('\n')) return;
        handled = true;
        let result, request;
        try {
          request = JSON.parse(body.slice(0, body.indexOf('\n')));
          if (
            !context ||
            !['state', 'read', 'read_features', 'seal', 'compact'].includes(request.op) ||
            request.generation !== generation ||
            request.file !== context.sessionManager.getSessionFile() ||
            request.sessionId !== context.sessionManager.getSessionId()
          )
            throw new Error('RUNTIME_SESSION_CHANGED');
          if (['seal', 'compact'].includes(request.op)) {
            if (request.version !== packageInfo.version)
              throw new Error('OWNER_COMPONENT_UPDATE_REQUIRED');
          }
          if (request.op === 'compact') {
            const input = compactInputSchema.safeParse(request.body);
            if (!input.success || input.data.interrupt) throw new Error('INVALID_ARGUMENTS');
            const value = await admission.compact(context.sessionManager, context, () => {
              connection.setTimeout(0);
              return new Promise((resolve, reject) =>
                context.compact({
                  customInstructions: input.data.instructions,
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
          } else {
            result = {
              data:
                request.op === 'read_features'
                  ? {
                      contract: READ_CONTRACT,
                      sessionFile: request.file,
                      sessionId: request.sessionId,
                      ...nativeReadFeatures(
                        pi.getAllTools?.(),
                        pi.getCommands?.(),
                        context.sessionManager.getLeafId(),
                      ),
                    }
                  : request.op === 'state'
                    ? {
                        isIdle: context.isIdle(),
                        hasPendingMessages: context.hasPendingMessages(),
                        sealed: admission.sealed(context.sessionManager),
                        ...inputActivity(context.sessionManager),
                      }
                    : {
                        sessionFile: request.file,
                        sessionId: request.sessionId,
                        ...(request.body?.view === 'runtime'
                          ? observation.read(request.body, context)
                          : prepareContextRead(
                              {
                                entries: context.sessionManager.getEntries(),
                                leafId: context.sessionManager.getLeafId(),
                                live: live.snapshot(),
                              },
                              request.body,
                              { ...sdk, readAdapters: request.readAdapters },
                            )),
                      },
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
        connection.end(
          JSON.stringify({
            generation,
            ...(['seal', 'compact'].includes(request?.op)
              ? { version: packageInfo.version, file: request.file, sessionId: request.sessionId }
              : {}),
            ...result,
          }) + '\n',
        );
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await fs.chmod(socket, 0o600);
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
