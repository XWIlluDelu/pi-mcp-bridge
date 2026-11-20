// Public Pi context observation for a Bridge-owned child. Never owns a claim.
import { ownerRequest } from '../owner-runtime.mjs';
import { sessionKey } from '../core/storage.mjs';
// Pi's extension loader supplies its own public exports, including the actual
// CLI class in bundled installations. Importing sdkEntry separately would not.
import * as sdk from '@earendil-works/pi-coding-agent';
import { reloadAdmission } from './reload-admission.mjs';
import {
  ownerServer,
  nativeOwnerRead,
  nativeOwnerObservers,
  observeNativeOwner,
} from './attachment-protocol.mjs';
import { parseCompactInput, compactContext, compactMetadata } from '../ops/compact.mjs';
import { sameModel, thinkingLevelSchema } from '../ops/models.mjs';

async function restoreEmptyContextSelection(pi, ctx, { file, sessionId, leafId }) {
  const manager = ctx.sessionManager;
  if (manager.getSessionFile() !== file || manager.getSessionId() !== sessionId) return;
  const branch = manager.getBranch(leafId);
  // Pi 1.5.2 skips restoration when projection produces no context messages.
  // Read the pre-start branch so startup's model/thinking entries cannot win.
  if (!branch.length || sdk.buildSessionContext(branch, leafId).messages.length) return;
  const savedModel = branch.findLast((entry) => entry.type === 'model_change');
  const savedThinking = branch.findLast((entry) => entry.type === 'thinking_level_change');
  if (!savedModel && !savedThinking) return;

  const args = sdk.parseArgs(process.argv.slice(2));
  const registry = ctx.modelRegistry;
  const model = !args.model && savedModel && registry.find(savedModel.provider, savedModel.modelId);
  let level = args.thinking;
  if (model && !sameModel(model, ctx.model)) {
    if ((await pi.setModel(model)) && !sameModel(model, ctx.model)) return;
  }
  if (level === undefined && args.model) {
    level = sdk.resolveCliModel({
      cliProvider: args.provider,
      cliModel: args.model,
      inlineApiKey: Boolean(args.apiKey),
      modelRuntime: {
        getModels: () => registry.getAll(),
        hasConfiguredAuth: (provider) => registry.hasConfiguredAuth({ provider }),
      },
    }).thinkingLevel;
  }
  level ??= savedThinking?.thinkingLevel;
  if (ctx.model && thinkingLevelSchema.safeParse(level).success && level !== pi.getThinkingLevel())
    pi.setThinkingLevel(level);
}

export default async function rpcObserver(pi) {
  const value = process.env.PI_MCP_RPC_OBSERVER;
  if (!value) return;
  const { socket, generation, ownerControl, resume } = JSON.parse(value);
  const admission = reloadAdmission(sdk.AgentSession);
  let server, context;
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
  const observers = nativeOwnerObservers('rpc_message_events', generation, ownerControl, lifecycle);
  pi.on('agent_start', (event) => observers.liveMessage.update(event));
  observeNativeOwner(pi, () => observers);
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
  if (resume?.leafId)
    pi.on('session_start', (event, ctx) => {
      if (event.reason === 'startup') return restoreEmptyContextSelection(pi, ctx, resume);
    });
  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    admission.setOnIdle(ctx.sessionManager, () => {
      if (ownerControl)
        void ownerRequest(
          ownerControl,
          {
            op: 'idle_candidate',
            session_id: sessionKey(
              ctx.sessionManager.getSessionFile(),
              ctx.sessionManager.getSessionId(),
            ),
            generation,
          },
          { signal: AbortSignal.timeout(2000) },
        ).catch(() => {});
    });
    observers.observation.reset();
    if (server) return;
    server = ownerServer(
      () => ({
        kind: 'rpc',
        generation,
        file: context?.sessionManager.getSessionFile(),
        sessionId: context?.sessionManager.getSessionId(),
      }),
      async (request, connection, _reply, binding) => {
        if (!context) throw new Error('RUNTIME_SESSION_CHANGED');
        const { op, body } = request;
        const ctx = context,
          manager = ctx.sessionManager;
        switch (op) {
          case 'compact': {
            const input = parseCompactInput(body);
            if (input.interrupt) throw new Error('INVALID_ARGUMENTS');
            return compactMetadata(
              await admission.compact(manager, ctx, () => {
                connection.setTimeout(0);
                return compactContext(ctx, input.instructions);
              }),
            );
          }
          case 'seal': {
            if (
              !body ||
              typeof body !== 'object' ||
              Array.isArray(body) ||
              Object.keys(body).length
            )
              throw new Error('INVALID_ARGUMENTS');
            return admission.seal(manager, ctx)
              ? { sealed: true }
              : { sealed: false, reason: 'busy' };
          }
          case 'state':
            return {
              isIdle: ctx.isIdle() && admission.idle(manager),
              hasPendingMessages: ctx.hasPendingMessages(),
              sealed: admission.sealed(manager),
            };
          case 'read_features':
          case 'read':
            return nativeOwnerRead(
              pi,
              binding,
              request,
              ctx,
              observers,
              sdk.buildSessionProjection,
            );
          default:
            throw new Error('INVALID_ATTACHED_OPERATION');
        }
      },
    );
    await server.listen(socket);
  });
  pi.on('session_shutdown', async () => {
    if (context) admission.setOnIdle(context.sessionManager, undefined);
    context = null;
    observers.liveMessage.reset();
    observers.observation.reset();
    // Reload/replacement recreates factories after shutdown handlers finish.
    // Close the owning listener (which unlinks its Unix socket) before rebinding.
    const listener = server;
    server = undefined;
    await listener?.close();
  });
}
