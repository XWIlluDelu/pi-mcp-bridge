// Bind existing owners through public SDK/RPC APIs. These helpers never open a
// session, spawn a process, read stdio, or access private admission hooks.
import { requireInterruptCompaction } from '../ops/compact.mjs';
import { nativeReadFeatures } from '../read/read-features.mjs';
import { nativeBashResult } from '../ops/bash-execution.mjs';
import { hasPromptSettings, promptOptions as options } from '../ops/prompt-input.mjs';
import { modelState } from '../ops/models.mjs';
import { createModelSetter } from '../ops/set-model.mjs';
import { requestStop } from '../ops/stop-execution.mjs';
import { reloadAdmission } from './reload-admission.mjs';
import {
  dispatchPromptWithoutAck,
  nativeSnapshot,
  unconfirmedPrompt,
} from './attachment-protocol.mjs';
const identity = (state) => ({ sessionFile: state.sessionFile, sessionId: state.sessionId });
const hostState = (value) => ({
  ...identity(value),
  ...modelState(value),
  sessionName: value.sessionName ?? null,
  isStreaming: value.isStreaming,
  isCompacting: value.isCompacting,
  pendingMessageCount: value.pendingMessageCount,
});
function assertIdentity(before, after) {
  if (before.sessionFile !== after.sessionFile || before.sessionId !== after.sessionId)
    throw new Error('RUNTIME_SESSION_CHANGED');
}
async function bound(state, expected, run) {
  const before = await state();
  if (expected) assertIdentity(expected, before);
  const verify = async () => assertIdentity(before, await state());
  const result = await run(before, verify);
  await verify();
  return result;
}

async function bashReceipt(result, onResult) {
  const output = nativeBashResult(result);
  await onResult(output);
  return output;
}

function tracker({ release, cancel, onError }) {
  const pending = new Set();
  function track(work) {
    const promise = Promise.resolve(work);
    pending.add(promise);
    promise.then(
      () => pending.delete(promise),
      (error) => {
        pending.delete(promise);
        // Host-local observer only; raw provider errors never enter MCP receipts.
        try {
          onError?.(error);
        } catch {}
      },
    );
    return promise;
  }
  return {
    track,
    lifecycle: release && {
      cancel,
      async release() {
        // The host must stop admission, abort/drain ALL its session work and close
        // the writer. Waiting only our dispatched promises cannot prove release.
        const outcome = await release();
        if (outcome?.released !== true) throw new Error('HOST_RELEASE_UNCONFIRMED');
        await Promise.allSettled(pending);
        return { released: true };
      },
    },
  };
}

export function createSdkHostBinding(session, { release, onError } = {}) {
  const tracked = tracker({
    release,
    onError,
    async cancel() {
      session.clearQueue();
      const cancellation = session.abort();
      session.abortBash();
      await cancellation;
    },
  });
  let pendingBashes = 0;
  // Pi's AgentSession methods live on its class prototype. Install the
  // admission observer there before the host admits local work: operation
  // lifetimes also cover input preparation, which Pi's isIdle does not include.
  if (Object.getPrototypeOf(session) === Object.prototype || !session.sessionManager)
    throw new Error('INVALID_HOST_SESSION');
  const admission = reloadAdmission(session.constructor);
  const verify = (expected) => assertIdentity(expected, session);
  const nativeActivity = {
    isIdle: () => session.isIdle && !session.isBashRunning,
    hasPendingMessages: () => session.pendingMessageCount > 0,
  };
  const isIdle = () =>
    nativeActivity.isIdle() && !pendingBashes && admission.idle(session.sessionManager);
  const state = async () => ({
    ...hostState(session),
    isIdle: isIdle(),
    isBashRunning: session.isBashRunning,
  });
  return {
    state,
    readFeatures: () =>
      nativeReadFeatures(
        session.getAllTools(),
        session.extensionRunner.getRegisteredCommands(),
        session.sessionManager.getLeafId(),
      ),
    snapshot: async () => {
      const before = identity(session);
      const snapshot = nativeSnapshot(session.sessionManager);
      verify(before);
      return { ...before, ...snapshot };
    },
    supportsImages: true,
    supportsIdleOnly: true,
    reload: async ({ beforeDispatch, ...expected }) => {
      verify(expected);
      const operation = admission.begin(session.sessionManager, nativeActivity, pendingBashes > 0);
      try {
        beforeDispatch?.();
        await operation.run(() => tracked.track(session.reload()));
        verify(expected);
        return { reloaded: true };
      } finally {
        operation.cancel();
      }
    },
    compact: ({ instructions, interrupt, beforeDispatch, ...expected }) =>
      bound(state, expected, (before) => {
        const compact = async () => {
          beforeDispatch?.();
          verify(before);
          try {
            return await tracked.track(session.compact(instructions));
          } catch {
            throw new Error('PI_REJECTED');
          }
        };
        return interrupt
          ? compact()
          : admission.compact(session.sessionManager, nativeActivity, compact, pendingBashes > 0);
      }),
    setModel: createModelSetter({
      state,
      models: () => session.modelRuntime.getAvailableSnapshot(),
      setModel: (model) => tracked.track(session.setModel(model)),
      setThinkingLevel: (level) => session.setThinkingLevel(level),
    }),
    submit: async ({ text, images, model, thinking_level, mode = 'steer', beforeDispatch }) => {
      if (hasPromptSettings({ model, thinking_level }))
        throw new Error('MODEL_SELECTION_UNSUPPORTED');
      beforeDispatch?.();
      if (mode === 'idle_only' && (!isIdle() || session.pendingMessageCount > 0))
        return { status: 'skipped', reason: 'busy' };
      return dispatchPromptWithoutAck(
        () =>
          tracked.track(session.prompt(text, { ...options(mode), ...(images ? { images } : {}) })),
        onError,
      );
    },
    bash: async ({ command, onResult, beforeDispatch, ...expected }) => {
      verify(expected);
      beforeDispatch?.();
      // Native executeBash observation excludes the user_bash hook and result
      // delivery. Keep idle admission fenced across the entire host operation.
      pendingBashes++;
      try {
        const handled = await session.extensionRunner.emitUserBash({
          type: 'user_bash',
          command,
          excludeFromContext: false,
          cwd: session.sessionManager.getCwd(),
        });
        verify(expected);
        let result;
        if (handled?.result) {
          result = handled.result;
          session.recordBashResult(command, result, { excludeFromContext: false });
        } else {
          beforeDispatch?.();
          result = await tracked.track(
            session.executeBash(command, undefined, {
              excludeFromContext: false,
              operations: handled?.operations,
            }),
          );
        }
        verify(expected);
        return await bashReceipt(result, onResult);
      } finally {
        pendingBashes--;
      }
    },
    stop: ({ onWithdraw, ...expected }) =>
      tracked.track(requestStop(session, onWithdraw, () => verify(expected))),
    ...tracked.lifecycle,
  };
}

export function createRpcHostBinding(client, { release, reload, onError } = {}) {
  if (
    ['getAvailableModels', 'setModel', 'setThinkingLevel'].some(
      (name) => typeof client?.[name] !== 'function',
    )
  )
    throw new Error('INVALID_HOST_CALLBACKS');
  const tracked = tracker({
    release,
    onError,
    cancel: () => requestStop(client, () => {}),
  });
  const state = async () => hostState(await client.getState());
  return {
    state,
    readFeatures: () =>
      bound(state, null, async () =>
        nativeReadFeatures(
          undefined,
          (await client.getCommands()).filter((command) => command.source === 'extension'),
          (await client.getEntries()).leafId,
        ),
      ),
    snapshot: () =>
      bound(state, null, async (before) => {
        const { entries, leafId } = await client.getEntries();
        return { ...identity(before), entries, leafId };
      }),
    supportsImages: true,
    // RpcClient has no reload command. The host callback must atomically refuse
    // busy local work, invoke beforeDispatch immediately before native reload,
    // and await completion on the same writer. A prompt ACK is not completion;
    // replacing the writer belongs to the host's registration lifecycle.
    reload:
      typeof reload === 'function'
        ? ({ beforeDispatch, ...expected }) =>
            bound(state, expected, async (before) => {
              const result = await tracked.track(reload({ ...identity(before), beforeDispatch }));
              if (result?.reloaded !== true) throw new Error('RELOAD_UNCONFIRMED');
              return { reloaded: true };
            })
        : undefined,
    compact: ({ instructions, interrupt, beforeDispatch, ...expected }) =>
      bound(state, expected, async (before) => {
        requireInterruptCompaction({ interrupt }, before);
        beforeDispatch?.();
        try {
          return await tracked.track(client.compact(instructions));
        } catch {
          throw new Error('HOST_COMPACT_UNCERTAIN');
        }
      }),
    setModel: createModelSetter({
      state,
      models: () => client.getAvailableModels(),
      setModel: (model) => tracked.track(client.setModel(model.provider, model.id)),
      setThinkingLevel: (level) => tracked.track(client.setThinkingLevel(level)),
    }),
    submit: async ({ text, images, model, thinking_level, mode = 'steer', beforeDispatch }) => {
      if (hasPromptSettings({ model, thinking_level }))
        throw new Error('MODEL_SELECTION_UNSUPPORTED');
      // getState excludes native preparation and cannot reserve idle admission
      // across getState -> prompt. Only a host-side gate can offer idle_only.
      if (mode === 'idle_only') return { status: 'rejected', reason: 'HOST_ADMISSION_UNSUPPORTED' };
      beforeDispatch?.();
      try {
        const disposition = await tracked.track(
          client.prompt(text, images, options(mode).streamingBehavior),
        );
        if (!['started', 'queued', 'handled'].includes(disposition)) return unconfirmedPrompt();
        return { status: 'accepted', disposition };
      } catch {
        // Official RpcClient exposes both negative ACKs and transport failures
        // as plain Errors. Never infer rejection by parsing a raw error string.
        return unconfirmedPrompt();
      }
    },
    bash: ({ command, onResult, beforeDispatch, ...expected }) =>
      bound(state, expected, async (_before, verify) => {
        beforeDispatch?.();
        const result = await tracked.track(client.bash(command));
        await verify();
        return bashReceipt(result, onResult);
      }),
    stop: ({ onWithdraw, ...expected } = {}) =>
      bound(state, expected, (_before, verify) =>
        tracked.track(
          requestStop(client, async (value) => {
            await verify();
            await onWithdraw(value);
          }),
        ),
      ),
    ...tracked.lifecycle,
  };
}
