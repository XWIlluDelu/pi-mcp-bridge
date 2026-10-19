// Cooperative host integration. Reserve the actual writer before it opens the
// saved target; this adapter never starts, stops or takes over a Pi process.
import fs from 'node:fs/promises';
import net from 'node:net';
import { assertSingleSessionFile, readSessionIdentity } from './data.mjs';

import { renderContextRead } from './context-read.mjs';
import { SEND_MODES, attachedPromptInput } from './prompt-input.mjs';
import { bashCapture } from './bash-execution.mjs';
import { stopReceipt, withdrawalCapture } from './stop-execution.mjs';
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
    return { status: 'accepted', disposition: value.disposition, completion: 'not_tracked' };
  if (value?.status === 'skipped' && value.reason === 'busy')
    return { status: 'skipped', reason: 'busy' };
  if (value?.status === 'unknown')
    return {
      status: 'unknown',
      dispatch: 'submitted',
      reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
      completion: 'not_tracked',
    };
  if (
    value?.status === 'rejected' &&
    ['PI_REJECTED', 'PROMPT_ADMISSION_PENDING', 'HOST_ADMISSION_UNSUPPORTED'].includes(value.reason)
  )
    return { status: 'rejected', reason: value.reason };
  fail('INVALID_HOST_RECEIPT');
}
export async function reserveHostSession({ attachmentDir, session, owner }) {
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
    releasing,
    closing;
  const sockets = new Set(),
    operations = new Set();
  async function identity(value) {
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
    await identity(value);
    return value;
  }
  async function retire() {
    ready = false;
    if ((await readClaim(attachmentDir, target))?.generation === record.generation)
      await updateOwner(attachmentDir, target, record, { phase: 'transitioning' });
  }
  async function release() {
    if (!callbacks?.release) fail('HOST_RELEASE_UNSUPPORTED');
    if (releasing) return releasing;
    ready = false; // Fence admissions before the first awaited lifecycle step.
    releasing = (async () => {
      await retire();
      // Cancellation must precede the operation drain: an active native bash
      // may only settle after the host aborts it. Writer close still happens
      // AFTER every admitted preparation/capture has settled.
      await identity();
      if (callbacks.cancel) await callbacks.cancel();
      else if (bashing && !stopping)
        await callbacks.stop({
          sessionFile: target.file,
          sessionId: target.header.id,
          onWithdraw: async () => {},
        });
      await Promise.allSettled([...operations]);
      await identity();
      const result = await callbacks.release();
      if (result?.released !== true) fail('HOST_RELEASE_FAILED');
      // A shared host may remain alive. The explicit host callback attests the
      // target writer, including non-bridge work, has been drained and closed.
      const current = await readClaim(attachmentDir, target);
      if (current?.generation !== record.generation) fail('RUNTIME_SESSION_CHANGED');
      await releaseOwner(attachmentDir, target, record);
      // Stop accepting immediately, but let the current release socket flush
      // its acknowledgment before the listener's close callback can complete.
      server?.close(() => {});
      return { released: true, generation: record.generation };
    })();
    return releasing;
  }
  function validateRequest(request) {
    if (
      !ready ||
      closed ||
      request?.generation !== record.generation ||
      request.file !== target.file ||
      request.sessionId !== target.header.id
    )
      fail('RUNTIME_SESSION_CHANGED');
  }
  async function operate(request) {
    const admittedAt = stopSequence,
      stoppedAtEntry = stopping;
    const observed = await state(),
      args = request.body ?? {};
    const pendingMessageCount =
      Number.isSafeInteger(observed.pendingMessageCount) && observed.pendingMessageCount >= 0
        ? observed.pendingMessageCount
        : null;
    let data;
    const beforeDispatch = () => {
      if (stoppedAtEntry || stopping || admittedAt !== stopSequence) fail('STOP_IN_PROGRESS');
      if (!ready || closed) fail('RUNTIME_SESSION_CHANGED');
    };
    if (request.op === 'state')
      data = {
        sessionFile: target.file,
        sessionId: target.header.id,
        generation: record.generation,
        isIdle: typeof observed.isIdle === 'boolean' ? observed.isIdle : null,
        isStreaming: typeof observed.isStreaming === 'boolean' ? observed.isStreaming : null,
        isCompacting: typeof observed.isCompacting === 'boolean' ? observed.isCompacting : null,
        pendingMessageCount,
      };
    else if (['read', 'snapshot'].includes(request.op)) {
      const snapshot = structuredClone(await callbacks.snapshot());
      await identity(snapshot);
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
      const revisionInput =
        request.op === 'snapshot'
          ? JSON.stringify({
              entries: snapshot.entries,
              leaf: snapshot.leafId,
              generation: record.generation,
            })
          : null;
      if (
        request.op === 'snapshot' &&
        Buffer.byteLength(revisionInput) > MAX_ATTACHMENT_SNAPSHOT_BYTES
      )
        fail('SESSION_TOO_LARGE');
      data =
        request.op === 'snapshot'
          ? {
              sessionFile: target.file,
              sessionId: target.header.id,
              entries: snapshot.entries,
              leafId: snapshot.leafId,
            }
          : renderContextRead(
              {
                header: target.header,
                entries: snapshot.entries,
                leafId: snapshot.leafId,
                live: snapshot.live ?? { available: false, source: 'host_snapshot' },
              },
              args,
            );
    } else if (request.op === 'send') {
      beforeDispatch();
      const input = attachedPromptInput(args);
      if (!SEND_MODES.includes(args.mode)) fail('INVALID_ATTACHED_SEND');
      // The host owns admission and idle observation. A transport-level idle
      // check cannot replace its input/preparation coordination.
      data = receipt(await callbacks.submit({ ...input, mode: args.mode, beforeDispatch }));
    } else if (request.op === 'bash') {
      if (typeof callbacks.bash !== 'function' || typeof callbacks.stop !== 'function')
        fail('BASH_UNSUPPORTED');
      if (typeof args.command !== 'string' || !args.command.length || args.command.length > 100000)
        fail('INVALID_ATTACHED_BASH');
      beforeDispatch();
      if (bashing) fail('BASH_IN_PROGRESS');
      const capture = bashCapture(attachmentDir, target, record.generation, args.recovery_id);
      let captured = false;
      bashing = true;
      try {
        const result = await callbacks.bash({
          command: args.command,
          sessionFile: target.file,
          sessionId: target.header.id,
          beforeDispatch,
          onResult: async (value) => {
            await state();
            await capture(value);
            captured = true;
          },
        });
        if (result?.completed !== true || !captured) fail('INVALID_BASH_RESULT');
        data = { completed: true };
      } finally {
        bashing = false;
      }
    } else if (request.op === 'stop') {
      if (typeof callbacks.stop !== 'function') fail('STOP_UNSUPPORTED');
      if (stopping) fail('STOP_IN_PROGRESS');
      const capture = withdrawalCapture(attachmentDir, target, record.generation, args.recovery_id);
      let captured = false;
      stopping = true;
      stopSequence++;
      try {
        data = stopReceipt(
          await callbacks.stop({
            sessionFile: target.file,
            sessionId: target.header.id,
            onWithdraw: async (value) => {
              await state();
              await capture(value);
              captured = true;
            },
          }),
        );
        if (!captured) fail('INVALID_STOP_RECEIPT');
      } finally {
        stopping = false;
      }
    } else fail('INVALID_ATTACHED_OPERATION');
    await state();
    return data;
  }
  async function close() {
    if (closing) return closing;
    closed = true;
    ready = false;
    closing = (async () => {
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
    return closing;
  }
  async function publish(value) {
    if (callbacks || closed) fail('HOST_ADAPTER_ALREADY_STARTED');
    if (
      !value ||
      !['state', 'snapshot', 'submit'].every((name) => typeof value[name] === 'function') ||
      ['release', 'cancel', 'stop', 'bash'].some(
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
              let data;
              if (request.op === 'release') data = await release();
              else {
                const operation = operate(request);
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
                  error: /^[A-Z_]{3,64}$/.test(error.code ?? error.message)
                    ? (error.code ?? error.message)
                    : 'HOST_OPERATION_FAILED',
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
        releaseSupported: Boolean(callbacks.release),
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
