// Bind existing owners through public SDK/RPC APIs. These helpers never open a
// session, spawn a process, read stdio, or access private admission hooks.
import { requireInterruptCompaction } from './compact.mjs';
import { nativeReadFeatures } from './read-features.mjs';
import { nativeBashResult } from './bash-execution.mjs';
import { hasPromptSettings, promptOptions as options } from './prompt-input.mjs';
import { modelState } from './models.mjs';
import { createModelSetter } from './set-model.mjs';
import { requestStop } from './stop-execution.mjs';
import { reloadAdmission } from './reload-admission.mjs';
const unknown = () => ({
  status: 'unknown',
  reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
});
const identity = (state) => ({ sessionFile: state.sessionFile, sessionId: state.sessionId });
function assertIdentity(before, after) {
  if (before.sessionFile !== after.sessionFile || before.sessionId !== after.sessionId)
    throw new Error('RUNTIME_SESSION_CHANGED');
}
function tracker(release, onError) {
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
    ...(release
      ? {
          release: async () => {
            // The host must stop admission, abort/drain ALL its session work and close
            // the writer. Waiting only our dispatched promises cannot prove release.
            const outcome = await release();
            if (outcome?.released !== true) throw new Error('HOST_RELEASE_UNCONFIRMED');
            await Promise.allSettled(pending);
            return { released: true };
          },
        }
      : {}),
  };
}

export function createSdkHostBinding(session, { release, onError } = {}) {
  const tracked = tracker(release, onError);
  let pendingBashes = 0;
  // Pi's AgentSession methods live on its class prototype. Install the
  // admission observer there before the host admits local work: operation
  // lifetimes also cover input preparation, which Pi's isIdle does not include.
  if (Object.getPrototypeOf(session) === Object.prototype || !session.sessionManager)
    throw new Error('INVALID_HOST_SESSION');
  const admission = reloadAdmission(session.constructor);
  const nativeActivity = {
    isIdle: () => session.isIdle && !session.isBashRunning,
    hasPendingMessages: () => session.pendingMessageCount > 0,
  };
  const isIdle = () =>
    nativeActivity.isIdle() && !pendingBashes && admission.idle(session.sessionManager);
  const state = async () => ({
    ...identity(session),
    ...modelState(session),
    sessionName: session.sessionName ?? null,
    isIdle: isIdle(),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isBashRunning: session.isBashRunning,
    pendingMessageCount: session.pendingMessageCount,
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
      const entries = session.sessionManager.getEntries(),
        leafId = session.sessionManager.getLeafId();
      assertIdentity(before, identity(session));
      return { ...before, entries, leafId };
    },
    supportsImages: true,
    reload: async ({ beforeDispatch, ...expected }) => {
      const before = identity(session);
      assertIdentity(expected, before);
      const operation = admission.begin(session.sessionManager, nativeActivity, pendingBashes > 0);
      try {
        beforeDispatch?.();
        await operation.run(() => tracked.track(session.reload()));
        assertIdentity(before, identity(session));
        return { reloaded: true };
      } finally {
        operation.cancel();
      }
    },
    compact: async ({ instructions, interrupt, beforeDispatch, ...expected }) => {
      const before = await state();
      assertIdentity(expected, before);
      const compact = async () => {
        beforeDispatch?.();
        assertIdentity(before, identity(session));
        try {
          return await tracked.track(session.compact(instructions));
        } catch {
          throw new Error('PI_REJECTED');
        }
      };
      const result = interrupt
        ? await compact()
        : await admission.compact(
            session.sessionManager,
            nativeActivity,
            compact,
            pendingBashes > 0,
          );
      assertIdentity(before, await state());
      return result;
    },
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
      // Public prompt() returns the input call's Promise, not an admission
      // receipt. A synchronous throw after entry cannot prove no side effect.
      try {
        tracked.track(session.prompt(text, { ...options(mode), ...(images ? { images } : {}) }));
      } catch (error) {
        try {
          onError?.(error);
        } catch {}
        return unknown();
      }
      return { status: 'dispatched', admission: 'unobservable' };
    },
    bash: async ({ command, onResult, beforeDispatch, ...expected }) => {
      const before = identity(session);
      assertIdentity(expected, before);
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
        assertIdentity(before, identity(session));
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
        assertIdentity(before, identity(session));
        const output = nativeBashResult(result);
        await onResult(output);
        return output;
      } finally {
        pendingBashes--;
      }
    },
    stop: async ({ onWithdraw, ...expected }) => {
      const before = identity(session);
      assertIdentity(expected, before);
      return tracked.track(
        requestStop(
          {
            clearQueue: () => {
              assertIdentity(before, identity(session));
              return session.clearQueue();
            },
            abort: () => session.abort(),
            abortBash: async () => session.abortBash(),
          },
          onWithdraw,
        ),
      );
    },
    ...(tracked.release
      ? {
          cancel: async () => {
            session.clearQueue();
            const cancellation = session.abort();
            session.abortBash();
            await cancellation;
          },
          release: tracked.release,
        }
      : {}),
  };
}

export function createRpcHostBinding(client, { release, reload, onError } = {}) {
  if (
    ['getAvailableModels', 'setModel', 'setThinkingLevel'].some(
      (name) => typeof client?.[name] !== 'function',
    )
  )
    throw new Error('INVALID_HOST_CALLBACKS');
  const tracked = tracker(release, onError);
  const state = async () => {
    const value = await client.getState();
    return {
      ...identity(value),
      ...modelState(value),
      sessionName: value.sessionName ?? null,
      isStreaming: value.isStreaming,
      isCompacting: value.isCompacting,
      pendingMessageCount: value.pendingMessageCount,
    };
  };
  return {
    state,
    readFeatures: async () => {
      const before = await state();
      const commands = await client.getCommands();
      const snapshot = await client.getEntries();
      assertIdentity(before, await state());
      return nativeReadFeatures(
        undefined,
        commands.filter((command) => command.source === 'extension'),
        snapshot.leafId,
      );
    },
    snapshot: async () => {
      const before = await state(),
        snapshot = await client.getEntries(),
        after = await state();
      assertIdentity(before, after);
      return {
        ...identity(after),
        entries: snapshot.entries,
        leafId: snapshot.leafId,
      };
    },
    supportsImages: true,
    // RpcClient has no reload command. The host callback must atomically refuse
    // busy local work, invoke beforeDispatch immediately before native reload,
    // and await completion on the same writer. A prompt ACK is not completion;
    // replacing the writer belongs to the host's registration lifecycle.
    reload:
      typeof reload === 'function'
        ? async ({ beforeDispatch, ...expected }) => {
            const before = await state();
            assertIdentity(expected, before);
            const result = await tracked.track(reload({ ...identity(before), beforeDispatch }));
            if (result?.reloaded !== true) throw new Error('RELOAD_UNCONFIRMED');
            assertIdentity(before, await state());
            return { reloaded: true };
          }
        : undefined,
    compact: async ({ instructions, interrupt, beforeDispatch, ...expected }) => {
      const before = await state();
      assertIdentity(expected, before);
      requireInterruptCompaction({ interrupt }, before);
      beforeDispatch?.();
      let result;
      try {
        result = await tracked.track(client.compact(instructions));
      } catch {
        throw new Error('HOST_COMPACT_UNCERTAIN');
      }
      assertIdentity(before, await state());
      return result;
    },
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
        if (!['started', 'queued', 'handled'].includes(disposition)) return unknown();
        return { status: 'accepted', disposition };
      } catch {
        // Official RpcClient exposes both negative ACKs and transport failures
        // as plain Errors. Never infer rejection by parsing a raw error string.
        return unknown();
      }
    },
    bash: async ({ command, onResult, beforeDispatch, ...expected }) => {
      const before = await state();
      assertIdentity(expected, before);
      beforeDispatch?.();
      const result = await tracked.track(client.bash(command));
      assertIdentity(before, await state());
      const output = nativeBashResult(result);
      await onResult(output);
      return output;
    },
    stop: async ({ onWithdraw, ...expected } = {}) => {
      const before = await state();
      assertIdentity(expected, before);
      const result = await tracked.track(
        requestStop(client, async (value) => {
          assertIdentity(before, await state());
          await onWithdraw(value);
        }),
      );
      assertIdentity(before, await state());
      return result;
    },
    ...(tracked.release
      ? {
          cancel: async () => {
            await requestStop(client, async () => {});
          },
          release: tracked.release,
        }
      : {}),
  };
}
