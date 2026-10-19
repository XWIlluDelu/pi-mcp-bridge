// Load explicitly in the owner's ordinary Pi TUI or RPC: -e /absolute/path/src/attach-extension.mjs
import fs from 'node:fs/promises';
import {
  modelPage,
  modelSettingsSchema,
  sameModel,
  assertThinkingLevel,
  modelSetting,
} from './models.mjs';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSingleSessionFile, readSessionIdentity } from './data.mjs';
import { atomicJson } from './storage.mjs';
import { renderContextRead } from './context-read.mjs';
import { SEND_MODES, attachedPromptInput, assertImageModel } from './prompt-input.mjs';
import { activityObservation } from './activity.mjs';
import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_ATTACHMENT_SNAPSHOT_BYTES,
} from './attachment-protocol.mjs';
import joinExtension from './join-extension.mjs';
import { LiveMessageObserver } from './live-message.mjs';
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

export default function attachExtension(pi) {
  const dir = process.env.PI_MCP_ATTACH_DIR;
  let active;
  if (!dir) return;
  joinExtension(pi);
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
  // These events occur after the relevant persistence; every IPC request also
  // validates, including the first request after a previously absent file appears.
  pi.on('agent_settled', async (event) => {
    if (!active?.ready) return;
    active.liveMessage.reset();
    active.settlement = {
      generation: active.record.generation,
      sequence: active.settlement.sequence + 1,
      observed_at: new Date().toISOString(),
      aborted: event.aborted,
    };
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
    try {
      await updateOwner(dir, runtime.session, runtime.record, { phase: 'transitioning' });
    } finally {
      await closeServer(runtime);
    }
    // A real quit is not reload/session replacement. Permit cold resume only
    // once this exact TUI process is dead; never release a still-live writer.
    if (event.reason === 'quit' && runtime.ctx.mode === 'tui')
      await updateOwner(dir, runtime.session, runtime.record, { coldReacquireAfterExit: true });
    // Keep the claim through quit/reload/replacement until exact process death or a fresh session_start.
  });
  pi.on('session_start', async (_event, ctx) => {
    if (!['tui', 'rpc'].includes(ctx.mode)) return;
    try {
      await privateDirectory(dir);
      const file = ctx.sessionManager.getSessionFile(),
        header = ctx.sessionManager.getHeader();
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
        server: null,
        ctx,
        fileObserved,
        liveMessage: new LiveMessageObserver('extension_message_events'),
        settlement: {
          generation: record.generation,
          sequence: 0,
          observed_at: null,
          aborted: null,
        },
      };
      let selecting = false;
      const activity = () =>
        activityObservation('attached_context', {
          idle: ctx.isIdle(),
          pending: ctx.hasPendingMessages(),
          settlement: runtime.settlement,
        });
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
            if (request.op === 'set_model' && Number.isInteger(request.body?.timeout_ms))
              socket.setTimeout(Math.min(30000, Math.max(50, request.body.timeout_ms)));
            await validateStorage(runtime);
            check(request);
            let data;
            const args = request.body ?? {};
            if (selecting && ['send', 'set_model'].includes(request.op))
              throw new AttachmentFailure('MODEL_SELECTION_PENDING');
            if (request.op === 'state')
              data = {
                sessionFile: file,
                sessionId: header.id,
                isStreaming: !ctx.isIdle(),
                generation: record.generation,
                activity: activity(),
              };
            else if (['read', 'snapshot'].includes(request.op)) {
              const entries = ctx.sessionManager.getEntries(),
                leafId = ctx.sessionManager.getLeafId();
              const revisionInput =
                request.op === 'snapshot'
                  ? JSON.stringify({ entries, leaf: leafId, generation: record.generation })
                  : null;
              if (
                request.op === 'snapshot' &&
                Buffer.byteLength(revisionInput) > MAX_ATTACHMENT_SNAPSHOT_BYTES
              )
                throw new AttachmentFailure('SESSION_TOO_LARGE');
              data =
                request.op === 'snapshot'
                  ? { sessionFile: file, sessionId: header.id, entries, leafId }
                  : renderContextRead(
                      { header, entries, leafId, live: runtime.liveMessage.snapshot() },
                      args,
                    );
            } else if (request.op === 'set_model') {
              const parsed = modelSettingsSchema.safeParse(args);
              if (!parsed.success) throw new AttachmentFailure('INVALID_MODEL_ARGUMENTS');
              const target = ctx.modelRegistry
                .getAvailable()
                .find((m) => sameModel(m, args.model ?? ctx.model));
              if (!target) throw new AttachmentFailure('MODEL_UNAVAILABLE');
              assertThinkingLevel(target, args.thinking_level);
              const previous = pi.getThinkingLevel();
              selecting = true;
              try {
                try {
                  if (args.model && !sameModel(ctx.model, target) && !(await pi.setModel(target)))
                    throw new Error('MODEL_UNAVAILABLE');
                  check(request);
                  if (args.thinking_level !== undefined) pi.setThinkingLevel(args.thinking_level);
                } catch {
                  throw new AttachmentFailure('MODEL_SELECTION_FAILED', true);
                }
                if (!sameModel(ctx.model, target))
                  throw new AttachmentFailure('MODEL_SELECTION_CHANGED', true);
                data = {
                  status: 'accepted',
                  ...modelSetting(ctx.model, pi.getThinkingLevel(), previous, args.thinking_level),
                  scope: 'session',
                };
              } finally {
                selecting = false;
              }
            } else if (request.op === 'models') {
              data = modelPage(
                ctx.modelRegistry.getAvailable(),
                ctx.model,
                pi.getThinkingLevel(),
                request.body ?? {},
              );
            } else if (request.op === 'send') {
              const input = attachedPromptInput(args);
              if (input.model) throw new AttachmentFailure('MODEL_SELECTION_UNSUPPORTED');
              if (!SEND_MODES.includes(args.mode))
                throw new AttachmentFailure('INVALID_ATTACHED_SEND');
              assertImageModel(input.images, ctx.model);
              // This command reaches owner-local control, outside MCP grants.
              // Pi dispatches slash commands before input events, so refuse them
              // at this remote admission boundary, including collision suffixes.
              if (/^\/bridge-join(?::\d+)?(?:\s|$)/.test(args.text))
                data = { status: 'rejected', reason: 'OWNER_LOCAL_COMMAND_REQUIRED' };
              else if (args.mode === 'idle_only' && !ctx.isIdle())
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
                  dispatch: 'submitted',
                  reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
                  completion: 'not_tracked',
                };
              }
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
        modelsSupported: true,
        modelSelectionSupported: true,
      });
      // A successful replacement lifecycle conclusively releases this process's previous native identity.
      await registryTransaction(dir, async () => {
        for (const name of await fs.readdir(dir)) {
          if (
            !/^ps_[a-f0-9]{32}\.owner\.json$/.test(name) ||
            path.join(dir, name) === claimFile(dir, session)
          )
            continue;
          const other = await readOwnerRecord(dir, path.join(dir, name));
          if (
            ['tui', 'extension'].includes(other?.kind) &&
            other.owner?.pid === owner.pid &&
            other.owner.start === owner.start &&
            other.owner.boot === owner.boot
          ) {
            if (other.noColdReacquire)
              await atomicJson(path.join(dir, name), { ...other, phase: 'released', owner: null });
            else await fs.unlink(path.join(dir, name));
          }
        }
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
