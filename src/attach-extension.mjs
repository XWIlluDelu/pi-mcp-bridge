// Load once through native Pi settings for ordinary TUI/RPC startup.
import fs from 'node:fs/promises';
import { compactInputSchema, compactMetadata, requireInterruptCompaction } from './compact.mjs';
import { modelState } from './models.mjs';
import { createModelSetter } from './set-model.mjs';
import net from 'node:net';
import path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertSingleSessionFile, readSessionIdentity } from './data.mjs';
import { atomicJson } from './storage.mjs';
import { prepareContextRead, READ_CONTRACT } from './context-read.mjs';
import { nativeSdk } from './pi-installation.mjs';
import {
  SEND_MODES,
  attachedPromptInput,
  remotePromptRejection,
  assertImageModel,
  hasPromptSettings,
} from './prompt-input.mjs';
import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_ATTACHMENT_SNAPSHOT_BYTES,
} from './attachment-protocol.mjs';
import joinExtension from './join-extension.mjs';
import { companionProfile, companionIncludes } from './companion-profile.mjs';
import { LiveMessageObserver } from './live-message.mjs';
import { ContextObservation } from './context-observation.mjs';
import {
  privateDirectory,
  processIdentity,
  ownerAlive,
  registryTransaction,
  readClaim,
  readOwnerRecord,
  claimFile,
  updateOwner,
  assertNoOtherLiveOwner,
  AttachmentFailure,
} from './attachments.mjs';

export default async function attachExtension(pi) {
  const profile = await companionProfile();
  if (!profile) return;
  const { dir, file } = profile;
  let active;
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
    if (!companionIncludes(profile, targetFile)) return;
    try {
      // Refuse an already-owned target before SessionManager.open can switch us.
      // This is a read-only admission check, not an atomic open reservation.
      await assertSingleSessionFile(targetFile, { allowMissing: true });
      await registryTransaction(dir, () =>
        assertNoOtherLiveOwner(dir, { file: targetFile }, { allowSameProcess: true }),
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
  async function retirePreviousClaims(currentFile, owner) {
    // Replacement/reload can reconstruct this extension, so use native identity
    // rather than closure state. Never retire a controller or a different process.
    if (
      !(await fs.stat(dir).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      }))
    )
      return;
    await registryTransaction(dir, async () => {
      for (const name of await fs.readdir(dir)) {
        if (!/^ps_[a-f0-9]{32}\.owner\.json$/.test(name)) continue;
        const file = path.join(dir, name);
        const other = await readOwnerRecord(dir, file, undefined, { owner });
        if (
          other?.file !== currentFile &&
          ['tui', 'extension'].includes(other?.kind) &&
          other.owner?.pid === owner.pid &&
          other.owner.start === owner.start &&
          other.owner.boot === owner.boot
        ) {
          await fs.unlink(file);
        }
      }
    });
  }
  async function closeServer(runtime) {
    if (!runtime) return;
    runtime.ready = false;
    for (const socket of runtime.connections) socket.destroy();
    await new Promise((resolve) => runtime.server.close(resolve));
  }
  async function validateStorage(runtime) {
    try {
      let stat = await assertSingleSessionFile(runtime.session.file, {
        allowMissing: !runtime.fileObserved,
      });
      if (
        !stat &&
        runtime.ctx.sessionManager
          .getEntries()
          .some((e) => e.type === 'message' && ['user', 'assistant'].includes(e.message?.role))
      ) {
        // First persistence can occur after the missing-file snapshot but
        // before the in-memory snapshot. Recheck the now-required file before
        // deciding that those observations represent a storage failure.
        stat = await assertSingleSessionFile(runtime.session.file);
      }
      if (!stat && runtime.session.header.version !== 3)
        throw new AttachmentFailure('ATTACH_REQUIRES_SAVED_SESSION');
      if (stat && !runtime.fileObserved) {
        const saved = await readSessionIdentity(runtime.session.file);
        if (saved.header.id !== runtime.session.header.id)
          throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
        runtime.fileObserved = true;
      }
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
  // All context transforms have finished before this phase, including MC even
  // when it loaded after the companion. Never mutate the observed event.
  pi.on('context_with_system', (event, ctx) => active?.observation.capture(event, ctx));
  // These events occur after the relevant persistence; every IPC request also
  // validates, including the first request after a previously absent file appears.
  pi.on('agent_settled', async () => {
    if (!active?.ready) return;
    active.liveMessage.reset();
    await validateStorage(active);
  });
  for (const event of ['session_info_changed', 'session_compact'])
    pi.on(event, async () => {
      if (active?.ready) await validateStorage(active);
    });
  pi.on('session_shutdown', async (event) => {
    const runtime = active;
    active = undefined;
    if (!runtime) return;
    runtime.ready = false; // Retire captured callbacks before the first asynchronous lifecycle step.
    runtime.observation.reset();
    try {
      await updateOwner(dir, runtime.session, runtime.record, { phase: 'transitioning' });
    } finally {
      await closeServer(runtime);
      // IPC disconnect is not completion: keep the old claim and native
      // context until admitted setters/compaction can no longer append.
      await Promise.allSettled([...runtime.mutations]);
    }
    // The identified claim blocks until exact death or successful switch-away.
    // Keep the claim through quit/reload/replacement until exact process death or a fresh session_start.
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!['tui', 'rpc'].includes(ctx.mode)) return;
    try {
      const file = ctx.sessionManager.getSessionFile();
      // Check only path metadata before inspecting entries or publishing IPC.
      // No-session runs and sessions outside the owner's roots remain ordinary Pi.
      if (!companionIncludes(profile, file)) {
        await retirePreviousClaims(file, await processIdentity());
        return;
      }
      await privateDirectory(dir);
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
      };
      record.socket = path.join(dir, `${owner.pid}-${record.generation.slice(0, 8)}.sock`);
      let fileObserved;
      const registered = await registryTransaction(dir, async () => {
        const observation = { session, ctx, fileObserved: false };
        await validateStorage(observation);
        fileObserved = observation.fileObserved;
        // The same path cannot be reserved under another live native identity,
        // whether first persistence has happened yet or not.
        await assertNoOtherLiveOwner(dir, session);
        const old = await readClaim(dir, session);
        const sameProcess =
          old?.owner &&
          old.owner.pid === owner.pid &&
          old.owner.start === owner.start &&
          old.owner.boot === owner.boot;
        if (old && (await ownerAlive(old.owner)) && !sameProcess) {
          if (ctx.mode === 'tui') ctx.shutdown();
          throw new AttachmentFailure('LIVE_OWNER_UNREACHABLE');
        }
        // An installed companion must not replace this writer's existing RPC/host
        // controller. Its endpoint and lifecycle remain with that controller.
        if (sameProcess && ['rpc', 'host'].includes(old.kind)) return false;
        if (old?.noColdReacquire) record.noColdReacquire = true;
        await atomicJson(claimFile(dir, session), record);
        return true;
      });
      if (!registered) return;
      // Publish blocking ownership before socket setup or any later fallible initialization.
      if (Buffer.byteLength(record.socket) > 100)
        throw new AttachmentFailure('ATTACHMENT_SOCKET_PATH_TOO_LONG');
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
        fileObserved,
        liveMessage: new LiveMessageObserver('extension_message_events'),
        observation: new ContextObservation(record.generation),
      };
      const activity = () => ({
        idle: ctx.isIdle() && runtime.mutations.size === 0,
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
      function check(request) {
        if (
          active !== runtime ||
          !runtime.ready ||
          request.generation !== record.generation ||
          request.file !== file ||
          request.sessionId !== header.id ||
          ctx.sessionManager.getSessionFile() !== file ||
          ctx.sessionManager.getSessionId() !== header.id
        )
          throw new AttachmentFailure('RUNTIME_SESSION_CHANGED');
      }
      const setModel = createModelSetter({
        state: () => {
          check({ generation: record.generation, file, sessionId: header.id });
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
      const server = net.createServer((socket) => {
        if (connections.size >= 16) {
          socket.destroy();
          return;
        }
        connections.add(socket);
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('close', () => connections.delete(socket));
        let buffer = '',
          handled = false;
        socket.on('data', async (chunk) => {
          if (handled) return;
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_ATTACHMENT_REQUEST_BYTES) {
            socket.destroy();
            return;
          }
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          handled = true;
          try {
            const request = JSON.parse(buffer.slice(0, end));
            check(request);
            await validateStorage(runtime);
            check(request);
            let data;
            const args = request.body ?? {};
            if (request.op === 'state')
              data = {
                sessionFile: file,
                sessionId: header.id,
                sessionName: ctx.sessionManager.getSessionName?.() ?? null,
                ...modelState({ model: ctx.model, thinkingLevel: pi.getThinkingLevel() }),
                isStreaming: !ctx.isIdle(),
                generation: record.generation,
                activity: activity(),
              };
            else if (['read', 'snapshot'].includes(request.op)) {
              const sdk =
                request.op === 'read' && args.view !== 'observed' ? await nativeSdk(profile) : null;
              const entries = ctx.sessionManager.getEntries(),
                leafId = ctx.sessionManager.getLeafId();
              const snapshotJson =
                request.op === 'snapshot'
                  ? JSON.stringify({ entries, leaf: leafId, generation: record.generation })
                  : null;
              if (
                request.op === 'snapshot' &&
                Buffer.byteLength(snapshotJson) > MAX_ATTACHMENT_SNAPSHOT_BYTES
              )
                throw new AttachmentFailure('SESSION_TOO_LARGE');
              if (request.op === 'snapshot')
                data = { sessionFile: file, sessionId: header.id, entries, leafId };
              else {
                data = {
                  sessionFile: file,
                  sessionId: header.id,
                  ...(args.view === 'observed'
                    ? runtime.observation.read(args, ctx)
                    : prepareContextRead(
                        { header, entries, leafId, live: runtime.liveMessage.snapshot() },
                        args,
                        sdk,
                      )),
                };
              }
            } else if (request.op === 'set_model') {
              if (typeof pi.setModel !== 'function' || typeof pi.setThinkingLevel !== 'function')
                throw new AttachmentFailure('MODEL_SELECTION_UNSUPPORTED');
              data = await trackMutation(
                setModel({
                  model: args.model,
                  thinking_level: args.thinking_level,
                  sessionFile: file,
                  sessionId: header.id,
                  beforeDispatch: () => check(request),
                }),
              );
              check(request);
            } else if (request.op === 'compact') {
              if (typeof ctx.compact !== 'function')
                throw new AttachmentFailure('COMPACT_UNSUPPORTED');
              const input = compactInputSchema.safeParse(args);
              if (!input.success) throw new AttachmentFailure('INVALID_ARGUMENTS');
              if (runtime.compacting) throw new AttachmentFailure('COMPACTION_PENDING');
              requireInterruptCompaction(input.data, {
                isIdle: ctx.isIdle(),
                hasPendingMessages: ctx.hasPendingMessages(),
              });
              check(request);
              runtime.compacting = true;
              socket.setTimeout(0); // Disconnect only suppresses the receipt.
              try {
                const value = await trackMutation(
                  new Promise((resolve, reject) =>
                    ctx.compact({
                      customInstructions: input.data.instructions,
                      onComplete: resolve,
                      onError: () => reject(new AttachmentFailure('PI_REJECTED')),
                    }),
                  ),
                );
                check(request);
                data = compactMetadata(value);
              } finally {
                runtime.compacting = false;
              }
            } else if (request.op === 'send') {
              if (runtime.compacting) throw new AttachmentFailure('COMPACTION_PENDING');
              if (setModel.pending) throw new AttachmentFailure('MODEL_SELECTION_PENDING');
              const input = attachedPromptInput(args);
              if (hasPromptSettings(input))
                throw new AttachmentFailure('MODEL_SELECTION_UNSUPPORTED');
              if (!SEND_MODES.includes(args.mode))
                throw new AttachmentFailure('INVALID_ATTACHED_SEND');
              assertImageModel(input.images, ctx.model);
              const rejection = remotePromptRejection(input.text);
              if (rejection) data = rejection;
              else if (args.mode === 'idle_only' && (!ctx.isIdle() || ctx.hasPendingMessages()))
                data = { status: 'skipped', reason: 'busy' };
              else {
                const options = { expandPromptTemplates: true };
                if (['default', 'steer'].includes(args.mode)) options.deliverAs = 'steer';
                if (args.mode === 'follow_up') options.deliverAs = 'followUp';
                pi.sendUserMessage(
                  input.images
                    ? [...(input.text ? [{ type: 'text', text: input.text }] : []), ...input.images]
                    : input.text,
                  options,
                );
                data = {
                  status: 'unknown',
                  reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
                };
              }
            } else if (request.op === 'bash') {
              throw new AttachmentFailure('BASH_UNSUPPORTED');
            } else if (request.op === 'stop') {
              // TUI ctx.abort + getEditorText can recover joined text (including
              // prior draft), but no public context API aborts independent bash.
              // RPC ctx also lacks clearQueue. Don't claim partial work is stop-all.
              throw new AttachmentFailure('STOP_UNSUPPORTED');
            } else if (request.op === 'shutdown') {
              if (ctx.mode === 'rpc') throw new AttachmentFailure('HOST_RELEASE_UNSUPPORTED');
              data = { shutdown: 'requested' };
              socket.end(JSON.stringify({ generation: record.generation, data }) + '\n', () => {
                try {
                  check(request);
                  ctx.shutdown();
                } catch {
                  /* Reload/replacement may invalidate the captured context before the flush callback. */
                }
              });
              return;
            } else throw new AttachmentFailure('INVALID_ATTACHED_OPERATION');
            socket.end(JSON.stringify({ generation: record.generation, data }) + '\n');
          } catch (error) {
            socket.end(
              JSON.stringify({
                generation: record.generation,
                error: /^[A-Z_]+$/.test(error.code ?? error.message)
                  ? (error.code ?? error.message)
                  : 'ATTACHED_OPERATION_FAILED',
              }) + '\n',
            );
          }
        });
      });
      runtime.server = server;
      active = runtime;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(record.socket, resolve);
      });
      await fs.chmod(record.socket, 0o600);
      runtime.ready = true;
      await updateOwner(dir, session, record, {
        phase: 'ready',
        imagesSupported: true,
        readContract: READ_CONTRACT,
      });
      // A successful replacement lifecycle conclusively releases this process's previous native identity.
      await retirePreviousClaims(file, owner);
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
