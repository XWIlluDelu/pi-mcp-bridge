// Cooperative host integration. Reserve the actual writer before it opens the
// saved target; this adapter never starts, stops or takes over a Pi process.
import { readSessionIdentity, sameSessionIdentity, servesSession } from '../core/data.mjs';

import { parseCompactInput, compactMetadata } from '../ops/compact.mjs';
import { assertReadFeatures } from '../read/read-features.mjs';
import { unavailableObservation } from '../read/context-observation.mjs';
import { attachedPromptInput, remotePromptRejection } from '../ops/prompt-input.mjs';
import { modelState, sameModel } from '../ops/models.mjs';
import { modelSettingsSchema, modelSettings } from '../ops/set-model.mjs';
import { limitBashResult } from '../ops/bash-execution.mjs';
import { stopReceipt, withdrawalCollector } from '../ops/stop-execution.mjs';
import { ownerControlSchemas } from '../mcp/tool-schemas.mjs';
import {
  ownerServer,
  closeOwnerServer,
  ownerProtocol,
  listenPrivate,
  ownerEnvelope,
  ownerIdentity,
  ownerReadFeatures,
  ownerRead,
  validNativeSnapshot,
  nativeBusy,
  pendingMessages,
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
  if (value?.status === 'dispatched' && value.admission === 'unobservable')
    return { status: 'dispatched', admission: 'unobservable' };
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
export async function reserveHostSession({
  attachmentDir,
  session,
  owner,
  buildSessionProjection,
}) {
  if (typeof buildSessionProjection !== 'function') fail('INVALID_HOST_PROJECTION');
  const target = structuredClone(session);
  owner ??= await processIdentity();
  if (!owner || !(await ownerAlive(owner))) fail('PROCESS_IDENTITY_UNAVAILABLE');
  const record = await reserveOwner(attachmentDir, target, 'host', owner);
  const identity = ownerIdentity(record);
  let callbacks,
    server,
    ready = false,
    closed = false,
    stopSequence = 0,
    releasing = false,
    writerReleased = false,
    releasePromise,
    closePromise;
  const sockets = new Set(),
    operations = new Set();
  const active = (op) =>
    operations.values().some((job) => job.lane && (op === undefined || job.lane === op));
  const drain = () => Promise.allSettled(operations.values().map((job) => job.task));
  function assertNativeIdentity(value) {
    if (!servesSession(value, target)) fail('RUNTIME_SESSION_CHANGED');
  }
  async function assertIdentity() {
    const current = await readClaim(attachmentDir, target);
    if (
      current?.generation !== record.generation ||
      isReleasedOwner(current) ||
      !(await ownerAlive(record.owner))
    )
      fail('RUNTIME_SESSION_CHANGED');
    if (!sameSessionIdentity(await readSessionIdentity(target.file), target))
      fail('RUNTIME_SESSION_CHANGED');
  }
  async function state() {
    const value = await callbacks.state();
    assertNativeIdentity(value);
    await assertIdentity();
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
        else if (active('bash') && !active('stop'))
          await callbacks.stop({
            ...identity,
            onWithdraw: async () => {},
          });
        await drain();
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
  const supportsBash = () =>
    typeof callbacks.bash === 'function' &&
    (typeof callbacks.cancel === 'function' || typeof callbacks.stop === 'function');
  async function operate(request, job, partial) {
    const { op } = request;
    const args = request.body ?? {};
    // Native work retains its lane even when the requesting socket goes away.
    const runActive = async (run) => {
      job.lane = op;
      try {
        return await run();
      } finally {
        job.lane = null;
      }
    };
    if (op === 'snapshot' || (op === 'read' && args.view !== 'runtime')) {
      // A snapshot callback binds its capture to the actual native session.
      // The RPC binding already samples native identity on each side of getEntries.
      const snapshot = await callbacks.snapshot();
      assertNativeIdentity(snapshot);
      if (!validNativeSnapshot(snapshot)) fail('INVALID_HOST_SNAPSHOT');
      const { entries, leafId } = snapshot;
      const data =
        op === 'snapshot'
          ? { ...identity, entries: structuredClone(entries), leafId }
          : ownerRead(
              record,
              { ...snapshot, live: snapshot.live ?? { available: false, source: 'host_snapshot' } },
              args,
              { buildSessionProjection, readAdapters: request.readAdapters },
            );
      await assertIdentity();
      return data;
    }
    const entryStopSequence = stopSequence,
      stoppingAtEntry = active('stop');
    const observed = await state();
    if (active('reload') && !['state', 'read', 'read_features'].includes(op))
      fail('RELOAD_IN_PROGRESS');
    if (Object.hasOwn(ownerControlSchemas, op) && !ownerControlSchemas[op].safeParse(args).success)
      fail('INVALID_ARGUMENTS');
    let data;
    const beforeDispatch = () => {
      if (stoppingAtEntry || active('stop') || entryStopSequence !== stopSequence)
        fail('STOP_IN_PROGRESS');
      if (!ready || closed) fail('RUNTIME_SESSION_CHANGED');
    };
    if (op === 'state')
      return {
        ...identity,
        generation: record.generation,
        ...(typeof observed.sessionName === 'string' || observed.sessionName === null
          ? { sessionName: observed.sessionName }
          : {}),
        isIdle: active() ? false : typeof observed.isIdle === 'boolean' ? observed.isIdle : null,
        isStreaming: typeof observed.isStreaming === 'boolean' ? observed.isStreaming : null,
        isCompacting: typeof observed.isCompacting === 'boolean' ? observed.isCompacting : null,
        isBashRunning: typeof observed.isBashRunning === 'boolean' ? observed.isBashRunning : null,
        pendingMessageCount: pendingMessages(observed),
        ...modelState(observed),
        capabilities: {
          send: true,
          command: supportsBash(),
          stop: typeof callbacks.stop === 'function',
        },
      };
    if (op === 'read_features') {
      const features = callbacks.readFeatures
        ? assertReadFeatures(await callbacks.readFeatures())
        : { available: false, tools: [], commands: [], leaf_id: null };
      data = ownerReadFeatures(record, features);
    } else if (op === 'read')
      data = {
        ...identity,
        ...unavailableObservation(args.session_id, 'host_observer_unavailable'),
      };
    else if (op === 'reload') {
      if (typeof callbacks.reload !== 'function') fail('RELOAD_UNSUPPORTED');
      if (Object.keys(args).length) fail('INVALID_ARGUMENTS');
      if (active() || nativeBusy(observed)) fail('RELOAD_BUSY');
      beforeDispatch();
      data = await runActive(async () => {
        let dispatched = false;
        try {
          const result = await callbacks.reload({
            ...identity,
            beforeDispatch: () => {
              beforeDispatch();
              dispatched = true;
            },
          });
          if (dispatched && result?.reloaded === true) return { reloaded: true };
        } catch (error) {
          if (!dispatched) throw error;
        }
        fail('RELOAD_UNCONFIRMED');
      });
    } else if (op === 'set_model') {
      if (typeof callbacks.setModel !== 'function') fail('MODEL_SELECTION_UNSUPPORTED');
      const input = modelSettingsSchema.safeParse(args);
      if (!input.success) fail('INVALID_ARGUMENTS');
      if (active('set_model')) fail('MODEL_SELECTION_PENDING');
      const beforeModelDispatch = () => {
        if (!ready || closed) fail('RUNTIME_SESSION_CHANGED');
        if (active('reload')) fail('RELOAD_IN_PROGRESS');
      };
      beforeModelDispatch();
      return runActive(async () => {
        const value = modelSettings(
          await callbacks.setModel({
            ...input.data,
            ...identity,
            beforeDispatch: beforeModelDispatch,
          }),
        );
        const actual = await state();
        if (!sameModel(value.model, actual.model) || value.thinking_level !== actual.thinkingLevel)
          fail('MODEL_SELECTION_CHANGED');
        return value;
      });
    } else if (op === 'compact') {
      if (typeof callbacks.compact !== 'function') fail('COMPACT_UNSUPPORTED');
      const input = parseCompactInput(args);
      if (active('compact')) fail('COMPACTION_PENDING');
      beforeDispatch();
      data = await runActive(async () =>
        compactMetadata(await callbacks.compact({ ...input, ...identity, beforeDispatch })),
      );
    } else if (op === 'send') {
      if (active('compact')) fail('COMPACTION_PENDING');
      if (active('set_model')) fail('MODEL_SELECTION_PENDING');
      beforeDispatch();
      const input = attachedPromptInput(args);
      if (input.images && callbacks.supportsImages !== true) fail('IMAGE_INPUT_UNSUPPORTED');
      // The host owns admission and idle observation. A transport-level idle
      // check cannot replace its input/preparation coordination.
      data =
        remotePromptRejection(input.text) ??
        (await runActive(async () =>
          receipt(await callbacks.submit({ ...input, beforeDispatch })),
        ));
    } else if (op === 'bash') {
      if (!supportsBash()) fail('BASH_UNSUPPORTED');
      beforeDispatch();
      if (active('bash')) fail('BASH_IN_PROGRESS');
      data = await runActive(async () => {
        const result = await callbacks.bash({
          command: args.command,
          ...identity,
          beforeDispatch,
          onResult: async (value) => {
            await state();
            partial(limitBashResult(value, args.max_chars));
          },
        });
        return limitBashResult(result, args.max_chars);
      });
    } else if (op === 'stop') {
      if (typeof callbacks.stop !== 'function') fail('STOP_UNSUPPORTED');
      if (active('stop')) fail('STOP_IN_PROGRESS');
      const withdrawn = withdrawalCollector(args.max_chars);
      stopSequence++;
      data = await runActive(async () => {
        const receipt = stopReceipt(
          await callbacks.stop({
            ...identity,
            onWithdraw: async (value) => {
              await state();
              partial({ withdrawal: { ...withdrawn.add(value), complete: false } });
            },
          }),
        );
        if (!withdrawn.value) fail('INVALID_STOP_RECEIPT');
        return { ...receipt, withdrawal: withdrawn.value };
      });
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
        await drain();
        await closeOwnerServer(server, sockets);
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
      (value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean') ||
      (value.supportsIdleOnly !== undefined && typeof value.supportsIdleOnly !== 'boolean') ||
      !['state', 'snapshot', 'submit'].every((name) => typeof value[name] === 'function') ||
      ['release', 'cancel', 'stop', 'bash', 'setModel', 'compact', 'reload', 'readFeatures'].some(
        (name) => value[name] !== undefined && typeof value[name] !== 'function',
      )
    )
      fail('INVALID_HOST_CALLBACKS');
    callbacks = value;
    try {
      await state();
      if (closed || releasing) fail('RUNTIME_SESSION_CHANGED');
      server = ownerServer(
        sockets,
        () => record,
        async (request, socket) => {
          if (closed || (!ready && !(releasing && request.op === 'release')))
            fail('RUNTIME_SESSION_CHANGED');
          if (request.op === 'release') return release();
          if (['compact', 'reload'].includes(request.op)) socket.setTimeout(0);
          const job = {
            task: Promise.resolve().then(() =>
              operate(request, job, (data) => {
                if (!socket.destroyed && !socket.writableEnded)
                  socket.write(ownerEnvelope(record, { partial: true, data }));
              }),
            ),
          };
          operations.add(job);
          try {
            return await job.task;
          } finally {
            operations.delete(job);
          }
        },
        'HOST_OPERATION_FAILED',
      );
      await listenPrivate(server, record.socket);
      await state();
      if (closed || releasing) fail('RUNTIME_SESSION_CHANGED');
      await updateOwner(attachmentDir, target, record, {
        phase: 'ready',
        imagesSupported: callbacks.supportsImages === true,
        idleOnlySupported: callbacks.supportsIdleOnly === true,
        ...ownerProtocol,
        reloadSupported: typeof callbacks.reload === 'function',
      });
      if (closed || releasing) {
        await retire();
        fail('RUNTIME_SESSION_CHANGED');
      }
      ready = true;
      return controller;
    } catch (error) {
      ready = false;
      await closeOwnerServer(server, sockets);
      // Retain the blocking claim even when endpoint publication fails.
      throw error;
    }
  }
  const controller = { record, ready: publish, release, close };
  return controller;
}
