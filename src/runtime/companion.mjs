// Load once through native Pi settings for ordinary TUI/RPC startup.
import fs from 'node:fs/promises';
import { reloadAdmission } from './reload-admission.mjs';
import { parseCompactInput, compactContext, compactMetadata } from '../ops/compact.mjs';
import { modelState } from '../ops/models.mjs';
import { createModelSetter } from '../ops/set-model.mjs';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  assertSingleSessionFile,
  readSessionIdentity,
  sameSessionIdentity,
} from '../core/data.mjs';
import { atomicJson } from '../core/storage.mjs';
import { attachedPromptInput, remotePromptRejection } from '../ops/prompt-input.mjs';
import {
  ownerServer,
  closeOwnerServer,
  listenPrivate,
  ownerIdentity,
  ownerProtocol,
  ownerReadFeatures,
  nativeSnapshot,
  nativeOwnerRead,
} from './attachment-protocol.mjs';
import joinExtension from './join-extension.mjs';
import {
  companionProfile,
  currentCompanionScope,
  companionIncludes,
} from './companion-profile.mjs';
import { LiveMessageObserver } from '../read/live-message.mjs';
import { ContextObservation } from '../read/context-observation.mjs';
import { nativeReadFeatures } from '../read/read-features.mjs';
import { SettledObserver } from '../events/settled-observer.mjs';
import { ownerSocket } from '../owner-runtime.mjs';
import {
  processIdentity,
  sameOwner,
  ownerAlive,
  registryTransaction,
  readClaim,
  claimFile,
  retireClaim,
  updateOwner,
  assertNoOtherLiveOwner,
  AttachmentFailure,
} from './attachments.mjs';

// A completed native shutdown authorizes only its paired successor. Keep this
// short-lived evidence across factory reloads, not a process-wide writer waiver.
const replacements = (globalThis[Symbol.for('pi-mcp-bridge.companion-replacements')] ??= new Map());
const replacementKey = (dir, file) => `${dir}\0${file}`;

export default async function attachExtension(pi, { AgentSession, buildSessionProjection } = {}) {
  const profile = await companionProfile();
  if (!profile) return;
  if (typeof buildSessionProjection !== 'function' || typeof AgentSession !== 'function')
    throw new Error('INVALID_HOST_PROJECTION');
  const { dir, file } = profile;
  const admission = reloadAdmission(AgentSession);
  let active, ownership;
  pi.registerCommand('bridge-reload', {
    description: 'Internal Bridge reload dispatch; use /reload for local reloads',
    handler: async (token, ctx) => {
      const operation = active?.reload;
      if (!operation || token !== operation.token || active.manager !== ctx.sessionManager) return;
      await operation.run(() => ctx.reload());
    },
  });
  joinExtension(pi, { dir, file });
  pi.on('session_before_switch', async (event, ctx) => {
    if (
      !['tui', 'rpc'].includes(ctx.mode) ||
      event.reason !== 'resume' ||
      typeof event.targetSessionFile !== 'string'
    )
      return;
    let targetFile = event.targetSessionFile;
    if (targetFile.startsWith('file://')) targetFile = fileURLToPath(targetFile);
    else if (targetFile === '~' || targetFile.startsWith('~/'))
      targetFile = path.join(homedir(), targetFile.slice(1));
    targetFile = path.resolve(targetFile);
    try {
      if (companionIncludes(await currentCompanionScope(profile), targetFile)) {
        await assertSingleSessionFile(targetFile, { allowMissing: true });
      } else {
        // Scope removal does not end an existing writer. Check only the existing
        // registry and target path metadata; do not register or read its history.
        const registry = await fs.stat(dir).catch((error) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!registry) return;
        targetFile = await fs.realpath(targetFile).catch((error) => {
          if (error.code === 'ENOENT') return targetFile;
          throw error;
        });
      }
      // Refuse an already-owned target before SessionManager.open can switch us.
      // This is a read-only admission check, not an atomic open reservation.
      await registryTransaction(dir, () =>
        assertNoOtherLiveOwner(
          dir,
          { file: targetFile },
          {
            replacing: active?.manager === ctx.sessionManager ? active : undefined,
            completeHandoff: true,
          },
        ),
      );
    } catch {
      try {
        ctx.ui.notify(
          'Session switch cancelled: target ownership could not be cleared. Use /bridge-join or host coordination.',
          'warning',
        );
      } catch {}
      return { cancel: true }; // Pi reports hook errors without cancelling.
    }
  });
  function replacementFor(event, manager) {
    const file = manager.getSessionFile();
    const previous = event.reason === 'reload' ? file : event.previousSessionFile;
    const replacement = replacements.get(replacementKey(dir, previous));
    if (
      replacement &&
      replacement.reason === event.reason &&
      (event.reason !== 'reload' || replacement.manager === manager) &&
      (!replacement.target || replacement.target === file)
    )
      return replacement;
  }
  function consumeReplacement(replacement) {
    if (
      replacement &&
      replacements.get(replacementKey(dir, replacement.session.file)) === replacement
    )
      replacements.delete(replacementKey(dir, replacement.session.file));
  }
  // Called under the registry mutex. Retire only the native context that
  // actually shut down, never other managers which happen to share its PID.
  async function retirePreviousClaim(replacement, currentSession) {
    if (
      !replacement ||
      (replacement.session.file === currentSession?.file &&
        replacement.session.header.id === currentSession.header.id)
    )
      return;
    const other = await readClaim(dir, replacement.session);
    const owner = replacement.record.owner;
    if (other && !['rpc', 'host', 'handoff'].includes(other.kind) && sameOwner(other.owner, owner))
      await retireClaim(dir, replacement.session, other);
  }
  async function validateStorage(runtime) {
    try {
      if (
        !runtime.fileObserved &&
        !(await assertSingleSessionFile(runtime.session.file, { allowMissing: true })) &&
        !runtime.ctx.sessionManager
          .getEntries()
          .some((e) => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role))
      ) {
        if (runtime.session.header.version !== 3)
          throw new AttachmentFailure('ATTACH_REQUIRES_SAVED_SESSION');
        return;
      }
      if (!sameSessionIdentity(await readSessionIdentity(runtime.session.file), runtime.session))
        throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
      runtime.fileObserved = true;
    } catch (error) {
      if (active === runtime) {
        runtime.ready = false;
        if (runtime.ctx.mode === 'tui')
          try {
            runtime.ctx.shutdown();
          } catch {}
      }
      throw error; // Retain the claim until exact process death/replacement.
    }
  }
  for (const event of ['message_start', 'message_update', 'message_end'])
    pi.on(event, (value) => {
      active?.liveMessage.update(value);
    });
  // All native context transforms have finished before this phase, regardless
  // of extension load order. Never mutate the observed event.
  pi.on('context_with_system', (event, ctx) => active?.observation.capture(event, ctx));
  pi.on('agent_start', (_event, ctx) => {
    if (active?.ready && active.manager === ctx.sessionManager)
      active.settled?.start(ctx.sessionManager);
  });
  // These events occur after the relevant persistence; every IPC request also
  // validates, including the first request after a previously absent file appears.
  pi.on('agent_settled', async (event, ctx) => {
    const runtime = active;
    if (!runtime?.ready || runtime.manager !== ctx.sessionManager) return;
    // Freeze leaf and result at native settlement, before storage/IPC awaits.
    const occurrence = runtime.settled?.capture(event, ctx.sessionManager);
    runtime.liveMessage.reset();
    await validateStorage(runtime);
    if (occurrence) await runtime.settled.send(occurrence);
  });
  for (const event of ['session_info_changed', 'session_compact'])
    pi.on(event, async () => {
      if (active?.ready) await validateStorage(active);
    });
  pi.on('session_shutdown', async (event) => {
    const runtime = active,
      current = ownership;
    active = ownership = undefined;
    if (!current) return;
    if (runtime) {
      runtime.ready = false; // Fence captured callbacks before the first await.
      runtime.observation.reset();
    }
    try {
      await updateOwner(dir, current.session, current.record, { phase: 'transitioning' });
    } finally {
      if (runtime) {
        await closeOwnerServer(runtime.server, runtime.connections);
        // IPC disconnect does not end admitted native work.
        await Promise.allSettled(runtime.mutations);
      }
      if (['reload', 'new', 'resume', 'fork'].includes(event.reason))
        replacements.set(replacementKey(dir, current.session.file), {
          ...current,
          reason: event.reason,
          target: event.targetSessionFile,
        });
    }
  });
  pi.on('session_start', async (event, ctx) => {
    if (!['tui', 'rpc'].includes(ctx.mode)) return;
    try {
      const manager = ctx.sessionManager;
      const file = manager.getSessionFile();
      // Check only path metadata before inspecting entries or publishing IPC.
      // No-session runs and sessions outside the owner's roots remain ordinary Pi.
      if (!companionIncludes(await currentCompanionScope(profile), file)) {
        if (replacementFor(event, manager))
          await registryTransaction(dir, async () => {
            const replacement = replacementFor(event, manager);
            if (replacement?.session.file === file) {
              // Scope removal disables control, not the still-live native writer.
              // Carry only its ownership forward without inspecting excluded data.
              ownership = { session: replacement.session, record: replacement.record, manager };
            } else await retirePreviousClaim(replacement);
            consumeReplacement(replacement);
          });
        return;
      }
      const header = ctx.sessionManager.getHeader();
      if (!file || !header || !path.isAbsolute(file))
        throw new AttachmentFailure('ATTACH_REQUIRES_SAVED_SESSION');
      const session = { file, header },
        owner = await processIdentity();
      const record = {
        kind: ctx.mode === 'tui' ? 'tui' : 'extension',
        mode: ctx.mode,
        file,
        sessionId: header.id,
        generation: randomUUID(),
        owner,
        phase: 'starting',
        ...(profile.ownerControl ? { completionSocket: ownerSocket(profile.ownerControl) } : {}),
      };
      record.socket = path.join(dir, `${owner.pid}-${record.generation.slice(0, 8)}.sock`);
      let fileObserved;
      const registered = await registryTransaction(dir, async () => {
        const observation = { session, ctx, fileObserved: false };
        await validateStorage(observation);
        fileObserved = observation.fileObserved;
        const replacement = replacementFor(event, manager);
        // The same path cannot be reserved under another live native identity,
        // whether first persistence has happened yet or not.
        const old = await assertNoOtherLiveOwner(dir, session, {
          replacing: replacement,
          completeHandoff: true,
        });
        const sameProcess = sameOwner(old?.owner, owner);
        // Rebinding UI/actions emits session_start again in the same native
        // extension runtime. Keep its existing endpoint instead of replacing it.
        if (
          active?.ready &&
          active.manager === manager &&
          old?.generation === active.record.generation
        )
          return false;
        // An installed companion must not replace this writer's existing RPC/host
        // controller. Its endpoint and lifecycle remain with that controller.
        if (sameProcess && ['rpc', 'host'].includes(old.kind)) {
          await retirePreviousClaim(replacement, session);
          consumeReplacement(replacement);
          return false;
        }
        const opening = sameProcess && old.kind === 'handoff' && old.phase === 'opening';
        if (
          old &&
          (await ownerAlive(old.owner)) &&
          !(sameProcess && (opening || replacement?.session.file === file))
        )
          throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
        if (old?.noColdReacquire && !opening) record.noColdReacquire = true;
        await retirePreviousClaim(replacement, session);
        await atomicJson(claimFile(dir, session), record);
        ownership = { session, record, manager };
        consumeReplacement(replacement);
        return true;
      });
      if (!registered) return;
      // Publish blocking ownership before socket setup or any later fallible initialization.
      const connections = new Set();
      const runtime = {
        session,
        record,
        connections,
        ready: false,
        compacting: false,
        mutations: new Set(),
        server: null,
        ctx,
        manager,
        fileObserved,
        liveMessage: new LiveMessageObserver('extension_message_events'),
        observation: new ContextObservation(record.generation),
        settled: profile.ownerControl
          ? new SettledObserver(profile.ownerControl, record.generation)
          : null,
      };
      active = runtime;
      const activity = () => ({
        idle: ctx.isIdle() && runtime.mutations.size === 0 && admission.idle(manager),
        pending_messages: ctx.hasPendingMessages(),
      });
      async function trackMutation(operation) {
        runtime.mutations.add(operation);
        try {
          return await operation;
        } finally {
          runtime.mutations.delete(operation);
        }
      }
      function check() {
        if (
          active !== runtime ||
          !runtime.ready ||
          ctx.sessionManager.getSessionFile() !== file ||
          ctx.sessionManager.getSessionId() !== header.id
        )
          throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
      }
      const setModel = createModelSetter({
        state: () => {
          check();
          return {
            sessionFile: file,
            sessionId: header.id,
            model: ctx.model,
            thinkingLevel: pi.getThinkingLevel(),
          };
        },
        models: () => ctx.modelRegistry.getAvailable(),
        setModel: (model) => pi.setModel(model),
        setThinkingLevel: (level) => pi.setThinkingLevel(level),
      });
      const server = ownerServer(
        connections,
        () => record,
        async (request, socket, reply) => {
          check();
          await validateStorage(runtime);
          check();
          let data;
          const args = request.body ?? {};
          if (
            admission.reloading(manager) &&
            !['state', 'read', 'read_features', 'snapshot'].includes(request.op)
          )
            throw new AttachmentFailure('RELOAD_IN_PROGRESS');
          if (request.op === 'state')
            data = {
              sessionFile: file,
              sessionId: header.id,
              sessionName: ctx.sessionManager.getSessionName() ?? null,
              ...modelState({ model: ctx.model, thinkingLevel: pi.getThinkingLevel() }),
              isStreaming: !ctx.isIdle(),
              generation: record.generation,
              activity: activity(),
              reloadComplete: admission.completed(manager),
            };
          else if (request.op === 'read_features')
            data = ownerReadFeatures(
              record,
              nativeReadFeatures(pi.getAllTools(), pi.getCommands(), manager.getLeafId()),
            );
          else if (request.op === 'snapshot')
            data = { ...ownerIdentity(record), ...nativeSnapshot(manager) };
          else if (request.op === 'read')
            data = nativeOwnerRead(record, args, ctx, runtime.observation, runtime.liveMessage, {
              buildSessionProjection,
              readAdapters: request.readAdapters,
            });
          else if (request.op === 'reload') {
            if (Object.keys(args).length) throw new AttachmentFailure('INVALID_ARGUMENTS');
            const operation = admission.begin(manager, ctx, runtime.mutations.size > 0);
            runtime.reload = operation;
            // Native reload closes this socket and drains ordinary mutations.
            // Flush admission first; never add reload itself to that drain set.
            reply({ data: { reloading: true } }, () => {
              try {
                check();
                pi.sendUserMessage(operation.command, { expandPromptTemplates: true });
              } catch {
                operation.cancel();
              }
            });
            return;
          } else if (request.op === 'set_model') {
            data = await trackMutation(
              setModel({
                model: args.model,
                thinking_level: args.thinking_level,
                sessionFile: file,
                sessionId: header.id,
                beforeDispatch: check,
              }),
            );
            check();
          } else if (request.op === 'compact') {
            const input = parseCompactInput(args);
            if (runtime.compacting) throw new AttachmentFailure('COMPACTION_PENDING');
            const compact = async () => {
              check();
              runtime.compacting = true;
              socket.setTimeout(0); // Disconnect only suppresses the receipt.
              try {
                return await trackMutation(compactContext(ctx, input.instructions));
              } finally {
                runtime.compacting = false;
              }
            };
            const value = input.interrupt
              ? await compact()
              : await admission.compact(manager, ctx, compact, runtime.mutations.size > 0);
            check();
            data = compactMetadata(value);
          } else if (request.op === 'send') {
            if (runtime.compacting) throw new AttachmentFailure('COMPACTION_PENDING');
            if (setModel.pending) throw new AttachmentFailure('MODEL_SELECTION_PENDING');
            const input = attachedPromptInput(args);
            const rejection = remotePromptRejection(input.text),
              currentActivity = activity();
            if (rejection) data = rejection;
            else if (
              input.mode === 'idle_only' &&
              (!currentActivity.idle || currentActivity.pending_messages)
            )
              data = { status: 'skipped', reason: 'busy' };
            else {
              const options = { expandPromptTemplates: true };
              if (input.mode === 'steer') options.deliverAs = 'steer';
              if (input.mode === 'follow_up') options.deliverAs = 'followUp';
              try {
                pi.sendUserMessage(
                  input.images ? [{ type: 'text', text: input.text }, ...input.images] : input.text,
                  options,
                );
                // The public API confirms invocation, not native admission or
                // completion. A later input handler may transform or handle it.
                data = { status: 'dispatched', admission: 'unobservable' };
              } catch {
                // Entering native dispatch can have side effects before a throw.
                data = { status: 'unknown', reason: 'PI_ACCEPTANCE_UNOBSERVABLE' };
              }
            }
          } else if (request.op === 'bash') {
            throw new AttachmentFailure('BASH_UNSUPPORTED');
          } else if (request.op === 'stop') {
            // TUI ctx.abort + getEditorText can recover joined text (including
            // prior draft), but no public context API aborts independent bash.
            // RPC ctx also lacks clearQueue. Don't claim partial work is stop-all.
            throw new AttachmentFailure('STOP_UNSUPPORTED');
          } else throw new AttachmentFailure('INVALID_ATTACHED_OPERATION');
          return data;
        },
      );
      runtime.server = server;
      await listenPrivate(server, record.socket);
      runtime.ready = true;
      await updateOwner(dir, session, record, {
        phase: 'ready',
        imagesSupported: true,
        ...ownerProtocol,
        reloadSupported: true,
      });
    } catch (error) {
      // Pi catches hook errors. A TUI can request graceful exit; an externally
      // owned RPC host must remain under its owner's lifecycle control.
      // A published starting claim is retained until its exact process exits.
      try {
        if (ctx.mode === 'tui') ctx.shutdown();
      } catch {
        /* Context may already be invalidated by another lifecycle. */
      }
      throw error;
    }
  });
}
