// Cooperative host integration. Reserve the actual writer before it opens the
// saved target; this adapter never starts, stops or takes over a Pi process.
import fs from 'node:fs/promises';
import { publicError } from './errors.mjs';
import net from 'node:net';
import { nativeSdk } from './pi-installation.mjs';
import { assertSingleSessionFile, readSessionIdentity } from './data.mjs';

import { compactInputSchema, compactMetadata } from './compact.mjs';
import { prepareContextRead, READ_CONTRACT } from './context-read.mjs';
import { unavailableObservation } from './context-observation.mjs';
import {
  SEND_MODES,
  attachedPromptInput,
  hasPromptSettings,
  remotePromptRejection,
} from './prompt-input.mjs';
import { modelState, sameModel } from './models.mjs';
import { modelSettingsSchema, modelSettings } from './set-model.mjs';
import { limitBashResult } from './bash-execution.mjs';
import { stopReceipt, withdrawalCollector } from './stop-execution.mjs';
import {
  MAX_ATTACHMENT_REQUEST_BYTES,
  MAX_ATTACHMENT_SNAPSHOT_BYTES,
} from './attachment-protocol.mjs';
import {
  reserveOwner,
  updateOwner,
  releaseOwner,
  readClaim,
  processIdentity,
  ownerAlive,
  isReleasedOwner,
  AttachmentFailure,
} from './attachments.mjs';
const fail = (code) => {
  throw new AttachmentFailure(code);
};
function receipt(value) {
  if (value?.status === 'accepted' && ['started', 'queued', 'handled'].includes(value.disposition))
    return { status: 'accepted', disposition: value.disposition };
  if (value?.status === 'skipped' && value.reason === 'busy')
    return { status: 'skipped', reason: 'busy' };
  if (value?.status === 'unknown')
    return {
      status: 'unknown',
      reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
    };
  if (
    value?.status === 'rejected' &&
    ['PI_REJECTED', 'PROMPT_ADMISSION_PENDING', 'HOST_ADMISSION_UNSUPPORTED'].includes(value.reason)
  )
    return { status: 'rejected', reason: value.reason };
  fail('INVALID_HOST_RECEIPT');
}
export async function reserveHostSession({ attachmentDir, session, owner, piExecutable }) {
  const target = structuredClone(session);
  owner ??= await processIdentity();
  if (!owner || !(await ownerAlive(owner))) fail('PROCESS_IDENTITY_UNAVAILABLE');
  const record = await reserveOwner(attachmentDir, target, 'host', owner);
  let callbacks,
    server,
    ready = false,
    closed = false,
    stopping = false,
    stopSequence = 0,
    bashing = false,
    settingModel = false,
    compacting = false,
    releasing = false,
    writerReleased = false,
    releasePromise,
    closePromise;
  const sockets = new Set(),
    operations = new Set();
  async function assertIdentity(value) {
    if (
      value !== undefined &&
      (value.sessionFile !== target.file || value.sessionId !== target.header.id)
    )
      fail('RUNTIME_SESSION_CHANGED');
    const current = await readClaim(attachmentDir, target);
    if (
      current?.generation !== record.generation ||
      isReleasedOwner(current) ||
      !(await ownerAlive(record.owner))
    )
      fail('RUNTIME_SESSION_CHANGED');
    await assertSingleSessionFile(target.file);
    if ((await readSessionIdentity(target.file)).header.id !== target.header.id)
      fail('RUNTIME_SESSION_CHANGED');
  }
  async function state() {
    const value = await callbacks.state();
    if (!value || typeof value !== 'object') fail('RUNTIME_SESSION_CHANGED');
    await assertIdentity(value);
    return value;
  }
  async function retire() {
    ready = false;
    if ((await readClaim(attachmentDir, target))?.generation === record.generation)
      await updateOwner(attachmentDir, target, record, { phase: 'transitioning' });
  }
  async function release() {
    if (!callbacks?.release) fail('HOST_RELEASE_UNSUPPORTED');
    if (releasePromise) return releasePromise;
    releasing = true;
    ready = false; // A failed close never reopens business admission.
    releasePromise = (async () => {
      if (!writerReleased) {
        await retire();
        // Cancel before draining: admitted work may depend on cancellation to
        // finish. An explicit retry resumes close, never the original business.
        await assertIdentity();
        if (callbacks.cancel) await callbacks.cancel();
        else if (bashing && !stopping)
          await callbacks.stop({
            sessionFile: target.file,
            sessionId: target.header.id,
            onWithdraw: async () => {},
          });
        await Promise.allSettled([...operations]);
        await assertIdentity();
        const result = await callbacks.release();
        if (result?.released !== true) fail('HOST_RELEASE_FAILED');
        // Keep this attestation if registry cleanup fails. Retrying cleanup
        // must not close the native writer a second time.
        writerReleased = true;
      }
      const current = await readClaim(attachmentDir, target);
      if (current && current.generation !== record.generation) fail('RUNTIME_SESSION_CHANGED');
      if (current && !isReleasedOwner(current)) await releaseOwner(attachmentDir, target, record);
      // Let the current release socket flush its acknowledgment.
      server?.close(() => {});
      return { released: true, generation: record.generation };
    })();
    try {
      return await releasePromise;
    } catch (error) {
      releasePromise = undefined;
      throw error;
    }
  }
  function validateRequest(request) {
    if (
      (!ready && !(releasing && request?.op === 'release')) ||
      closed ||
      request?.generation !== record.generation ||
      request.file !== target.file ||
      request.sessionId !== target.header.id
    )
      fail('RUNTIME_SESSION_CHANGED');
  }
  const supportsBash = () =>
    typeof callbacks.bash === 'function' &&
    (typeof callbacks.cancel === 'function' || typeof callbacks.stop === 'function');
  async function operate(request, partial) {
    const entryStopSequence = stopSequence,
      stoppingAtEntry = stopping;
    const observed = await state(),
      args = request.body ?? {};
    if (
      ['bash', 'stop'].includes(request.op) &&
      (Object.keys(args).some(
        (key) =>
          !(
            request.op === 'bash'
              ? ['command', 'max_chars', 'timeout_ms']
              : ['max_chars', 'timeout_ms']
          ).includes(key),
      ) ||
        (args.max_chars !== undefined &&
          (!Number.isInteger(args.max_chars) || args.max_chars < 256 || args.max_chars > 32768)) ||
        (args.timeout_ms !== undefined &&
          (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 50 || args.timeout_ms > 30000)))
    )
      fail('INVALID_ARGUMENTS');
    const pendingMessageCount =
      Number.isSafeInteger(observed.pendingMessageCount) && observed.pendingMessageCount >= 0
        ? observed.pendingMessageCount
        : null;
    let data;
    const beforeDispatch = () => {
      if (stoppingAtEntry || stopping || entryStopSequence !== stopSequence)
        fail('STOP_IN_PROGRESS');
      if (!ready || closed) fail('RUNTIME_SESSION_CHANGED');
    };
    if (request.op === 'state')
      data = {
        sessionFile: target.file,
        sessionId: target.header.id,
        generation: record.generation,
        ...(typeof observed.sessionName === 'string' || observed.sessionName === null
          ? { sessionName: observed.sessionName }
          : {}),
        isIdle:
          bashing || stopping || settingModel || compacting
            ? false
            : typeof observed.isIdle === 'boolean'
              ? observed.isIdle
              : null,
        isStreaming: typeof observed.isStreaming === 'boolean' ? observed.isStreaming : null,
        isCompacting: typeof observed.isCompacting === 'boolean' ? observed.isCompacting : null,
        isBashRunning: typeof observed.isBashRunning === 'boolean' ? observed.isBashRunning : null,
        pendingMessageCount,
        ...modelState(observed),
        capabilities: {
          send: true,
          command: supportsBash(),
          stop: typeof callbacks.stop === 'function',
        },
      };
    else if (request.op === 'read' && args.view === 'observed')
      data = {
        sessionFile: target.file,
        sessionId: target.header.id,
        ...unavailableObservation(args.session_id, 'host_observer_unavailable'),
      };
    else if (['read', 'snapshot'].includes(request.op)) {
      const sdk = request.op === 'read' ? await nativeSdk({ piExecutable }) : null;
      const observed = await callbacks.snapshot();
      const snapshot = request.op === 'snapshot' ? structuredClone(observed) : observed;
      await assertIdentity(snapshot);
      if (
        !Array.isArray(snapshot?.entries) ||
        !snapshot.entries.every(
          (entry) => typeof entry?.id === 'string' && entry.id.length <= 128,
        ) ||
        !(
          snapshot.leafId === null ||
          (typeof snapshot.leafId === 'string' && snapshot.leafId.length <= 128)
        )
      )
        fail('INVALID_HOST_SNAPSHOT');
      const snapshotJson =
        request.op === 'snapshot'
          ? JSON.stringify({
              entries: snapshot.entries,
              leaf: snapshot.leafId,
              generation: record.generation,
            })
          : null;
      if (
        request.op === 'snapshot' &&
        Buffer.byteLength(snapshotJson) > MAX_ATTACHMENT_SNAPSHOT_BYTES
      )
        fail('SESSION_TOO_LARGE');
      if (request.op === 'snapshot')
        data = {
          sessionFile: target.file,
          sessionId: target.header.id,
          entries: snapshot.entries,
          leafId: snapshot.leafId,
        };
      else {
        data = {
          sessionFile: target.file,
          sessionId: target.header.id,
          ...prepareContextRead(
            {
              header: target.header,
              entries: snapshot.entries,
              leafId: snapshot.leafId,
              live: snapshot.live ?? { available: false, source: 'host_snapshot' },
            },
            args,
            sdk,
          ),
        };
      }
    } else if (request.op === 'set_model') {
      if (typeof callbacks.setModel !== 'function') fail('MODEL_SELECTION_UNSUPPORTED');
      const input = modelSettingsSchema.safeParse(args);
      if (!input.success) fail('INVALID_ARGUMENTS');
      if (settingModel) fail('MODEL_SELECTION_PENDING');
      const beforeModelDispatch = () => {
        if (!ready || closed) fail('RUNTIME_SESSION_CHANGED');
      };
      beforeModelDispatch();
      settingModel = true;
      try {
        const value = modelSettings(
          await callbacks.setModel({
            ...input.data,
            sessionFile: target.file,
            sessionId: target.header.id,
            beforeDispatch: beforeModelDispatch,
          }),
        );
        const actual = await state();
        if (!sameModel(value.model, actual.model) || value.thinking_level !== actual.thinkingLevel)
          fail('MODEL_SELECTION_CHANGED');
        data = value;
      } finally {
        settingModel = false;
      }
    } else if (request.op === 'compact') {
      if (typeof callbacks.compact !== 'function') fail('COMPACT_UNSUPPORTED');
      const input = compactInputSchema.safeParse(args);
      if (!input.success) fail('INVALID_ARGUMENTS');
      if (compacting) fail('COMPACTION_PENDING');
      beforeDispatch();
      compacting = true;
      try {
        data = compactMetadata(
          await callbacks.compact({
            ...input.data,
            sessionFile: target.file,
            sessionId: target.header.id,
            beforeDispatch,
          }),
        );
      } finally {
        compacting = false;
      }
    } else if (request.op === 'send') {
      if (compacting) fail('COMPACTION_PENDING');
      if (settingModel) fail('MODEL_SELECTION_PENDING');
      beforeDispatch();
      const input = attachedPromptInput(args);
      if (hasPromptSettings(input)) fail('MODEL_SELECTION_UNSUPPORTED');
      if (!SEND_MODES.includes(args.mode)) fail('INVALID_ATTACHED_SEND');
      if (input.images && callbacks.supportsImages !== true) fail('IMAGE_INPUT_UNSUPPORTED');
      // The host owns admission and idle observation. A transport-level idle
      // check cannot replace its input/preparation coordination.
      data =
        remotePromptRejection(input.text) ??
        receipt(await callbacks.submit({ ...input, mode: args.mode, beforeDispatch }));
    } else if (request.op === 'bash') {
      if (!supportsBash()) fail('BASH_UNSUPPORTED');
      if (typeof args.command !== 'string' || !args.command.length || args.command.length > 100000)
        fail('INVALID_ATTACHED_BASH');
      beforeDispatch();
      if (bashing) fail('BASH_IN_PROGRESS');
      bashing = true;
      try {
        const result = await callbacks.bash({
          command: args.command,
          sessionFile: target.file,
          sessionId: target.header.id,
          beforeDispatch,
          onResult: async (value) => {
            await state();
            partial(limitBashResult(value, args.max_chars));
          },
        });
        data = limitBashResult(result, args.max_chars);
      } finally {
        bashing = false;
      }
    } else if (request.op === 'stop') {
      if (typeof callbacks.stop !== 'function') fail('STOP_UNSUPPORTED');
      if (stopping) fail('STOP_IN_PROGRESS');
      const withdrawn = withdrawalCollector(args.max_chars);
      stopping = true;
      stopSequence++;
      try {
        data = stopReceipt(
          await callbacks.stop({
            sessionFile: target.file,
            sessionId: target.header.id,
            onWithdraw: async (value) => {
              await state();
              partial({ withdrawal: { ...withdrawn.add(value), complete: false } });
            },
          }),
        );
        if (!withdrawn.value) fail('INVALID_STOP_RECEIPT');
        data = { ...data, withdrawal: withdrawn.value };
      } finally {
        stopping = false;
      }
    } else fail('INVALID_ATTACHED_OPERATION');
    await state();
    return data;
  }
  async function close() {
    if (closePromise) return closePromise;
    closed = true;
    ready = false;
    closePromise = (async () => {
      try {
        await retire();
      } finally {
        await Promise.allSettled([...operations]);
        for (const socket of sockets) socket.destroy();
        if (server) await new Promise((resolve) => server.close(resolve));
      }
      // Controller disconnect is not proof the actual writer has exited.
      if (!(await ownerAlive(record.owner))) await releaseOwner(attachmentDir, target, record);
    })();
    return closePromise;
  }
  async function publish(value) {
    if (callbacks || closed) fail('HOST_ADAPTER_ALREADY_STARTED');
    if (
      !value ||
      Object.keys(value).some(
        (key) =>
          ![
            'state',
            'snapshot',
            'submit',
            'supportsImages',
            'release',
            'cancel',
            'stop',
            'bash',
            'setModel',
            'compact',
          ].includes(key),
      ) ||
      (value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean') ||
      !['state', 'snapshot', 'submit'].every((name) => typeof value[name] === 'function') ||
      ['release', 'cancel', 'stop', 'bash', 'setModel', 'compact'].some(
        (name) => value[name] !== undefined && typeof value[name] !== 'function',
      )
    )
      fail('INVALID_HOST_CALLBACKS');
    callbacks = value;
    try {
      await state();
      if (closed || releasing) fail('RUNTIME_SESSION_CHANGED');
      server = net.createServer((socket) => {
        if (sockets.size >= 16) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.setEncoding('utf8');
        socket.setTimeout(5000, () => socket.destroy());
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        let buffer = '',
          handled = false;
        socket.on('data', (chunk) => {
          if (handled) return;
          buffer += chunk;
          if (Buffer.byteLength(buffer) > MAX_ATTACHMENT_REQUEST_BYTES) {
            socket.destroy();
            return;
          }
          const end = buffer.indexOf('\n');
          if (end < 0) return;
          handled = true;
          const task = (async () => {
            try {
              const request = JSON.parse(buffer.slice(0, end));
              validateRequest(request);
              if (
                ['stop', 'bash'].includes(request.op) &&
                Number.isInteger(request.body?.timeout_ms)
              )
                socket.setTimeout(Math.min(30000, Math.max(50, request.body.timeout_ms)));
              if (request.op === 'compact') socket.setTimeout(0);
              let data;
              if (request.op === 'release') data = await release();
              else {
                const operation = operate(request, (data) => {
                  if (!socket.destroyed && !socket.writableEnded)
                    socket.write(
                      JSON.stringify({ generation: record.generation, partial: true, data }) + '\n',
                    );
                });
                operations.add(operation);
                try {
                  data = await operation;
                } finally {
                  operations.delete(operation);
                }
              }
              socket.end(JSON.stringify({ generation: record.generation, data }) + '\n');
            } catch (error) {
              socket.end(
                JSON.stringify({
                  generation: record.generation,
                  error: publicError(error, 'HOST_OPERATION_FAILED'),
                }) + '\n',
              );
            }
          })();
          task.catch(() => socket.destroy());
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(record.socket, resolve);
      });
      await fs.chmod(record.socket, 0o600);
      await state();
      if (closed || releasing) fail('RUNTIME_SESSION_CHANGED');
      await updateOwner(attachmentDir, target, record, {
        phase: 'ready',
        imagesSupported: callbacks.supportsImages === true,
        readContract: READ_CONTRACT,
      });
      if (closed || releasing) {
        await retire();
        fail('RUNTIME_SESSION_CHANGED');
      }
      ready = true;
      return controller;
    } catch (error) {
      ready = false;
      for (const socket of sockets) socket.destroy();
      if (server) await new Promise((resolve) => server.close(resolve));
      // Retain the blocking claim even when endpoint publication fails.
      throw error;
    }
  }
  const controller = { record, ready: publish, release, close };
  return controller;
}
