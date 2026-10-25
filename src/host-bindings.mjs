// Bind existing owners through public SDK/RPC APIs. These helpers never open a
// session, spawn a process, read stdio, or access private admission hooks.
import { requireInterruptCompaction } from './compact.mjs';
import { nativeReadFeatures } from './read-features.mjs';
import { nativeBashResult } from './bash-execution.mjs';
import { SEND_MODES, hasPromptSettings, promptOptions as options } from './prompt-input.mjs';
import { modelState } from './models.mjs';
import { createModelSetter } from './set-model.mjs';
import { requestRpcStop, stopReceipt } from './stop-execution.mjs';
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
  const pending = new Map();
  function track(work, kind) {
    const promise = Promise.resolve(work);
    pending.set(promise, kind);
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
    get submitting() {
      return [...pending.values()].includes('submit');
    },
    ...(release
      ? {
          release: async () => {
            // The host must stop admission, abort/drain ALL its session work and close
            // the writer. Waiting only our dispatched promises cannot prove release.
            const outcome = await release();
            if (outcome?.released !== true) throw new Error('HOST_RELEASE_UNCONFIRMED');
            await Promise.allSettled([...pending.keys()]);
            return { released: true };
          },
        }
      : {}),
  };
}

export function createSdkHostBinding(session, { release, onError } = {}) {
  const tracked = tracker(release, onError);
  // Install before the host admits local work: public operation lifetimes also
  // cover input preparation, which Pi's isIdle does not include.
  const admission =
    session.constructor !== Object &&
    typeof session.constructor?.prototype?.reload === 'function' &&
    session.sessionManager
      ? reloadAdmission(session.constructor)
      : null;
  const state = async () => ({
    ...identity(session),
    ...modelState(session),
    ...('sessionName' in session ? { sessionName: session.sessionName ?? null } : {}),
    isIdle:
      session.isIdle &&
      !tracked.submitting &&
      (!admission || admission.idle(session.sessionManager)),
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    isBashRunning: session.isBashRunning,
    pendingMessageCount: session.pendingMessageCount,
  });
  return {
    state,
    readFeatures: () =>
      nativeReadFeatures(
        session.getAllTools?.(),
        session.extensionRunner?.getRegisteredCommands?.(),
        session.sessionManager?.getLeafId?.(),
      ),
    snapshot: async () => {
      const before = identity(session);
      const entries = session.sessionManager.getEntries(),
        leafId = session.sessionManager.getLeafId();
      assertIdentity(before, identity(session));
      return { ...before, entries, leafId };
    },
    supportsImages: true,
    reload: admission
      ? async ({ beforeDispatch, ...expected }) => {
          const before = identity(session);
          assertIdentity(expected, before);
          const operation = admission.begin(
            session.sessionManager,
            {
              isIdle: () => session.isIdle && !session.isBashRunning,
              hasPendingMessages: () => session.pendingMessageCount > 0,
            },
            tracked.submitting,
          );
          try {
            beforeDispatch?.();
            await operation.run(() => tracked.track(session.reload()));
            assertIdentity(before, identity(session));
            return { reloaded: true };
          } finally {
            operation.cancel();
          }
        }
      : undefined,
    compact:
      typeof session.compact === 'function'
        ? async ({ instructions, interrupt, beforeDispatch, ...expected }) => {
            const before = await state();
            assertIdentity(expected, before);
            requireInterruptCompaction({ interrupt }, before);
            beforeDispatch?.();
            let result;
            try {
              result = await tracked.track(session.compact(instructions));
            } catch {
              throw new Error('PI_REJECTED');
            }
            assertIdentity(before, await state());
            return result;
          }
        : undefined,
    setModel:
      typeof session.modelRuntime?.getAvailableSnapshot === 'function' &&
      typeof session.setModel === 'function' &&
      typeof session.setThinkingLevel === 'function'
        ? createModelSetter({
            state,
            models: () => session.modelRuntime.getAvailableSnapshot(),
            setModel: (model) => tracked.track(session.setModel(model)),
            setThinkingLevel: (level) => session.setThinkingLevel(level),
          })
        : undefined,
    submit: async ({ text, images, model, thinking_level, mode = 'steer', beforeDispatch }) => {
      if (hasPromptSettings({ model, thinking_level }))
        throw new Error('MODEL_SELECTION_UNSUPPORTED');
      if (!SEND_MODES.includes(mode)) throw new Error('INVALID_HOST_SUBMISSION');
      beforeDispatch?.();
      if (
        mode === 'idle_only' &&
        (tracked.submitting || !session.isIdle || session.pendingMessageCount > 0)
      )
        return { status: 'skipped', reason: 'busy' };
      // Public prompt() returns the input call's Promise, not an admission
      // receipt. A synchronous throw after entry cannot prove no side effect.
      try {
        tracked.track(
          session.prompt(text, { ...options(mode), ...(images ? { images } : {}) }),
          'submit',
        );
      } catch (error) {
        try {
          onError?.(error);
        } catch {}
        return unknown();
      }
      return { status: 'dispatched', admission: 'unobservable' };
    },
    bash: async ({ command, onResult, beforeDispatch, ...expected }) => {
      if (
        typeof onResult !== 'function' ||
        !['executeBash', 'recordBashResult', 'clearQueue', 'abort', 'abortBash'].every(
          (name) => typeof session[name] === 'function',
        ) ||
        typeof session.extensionRunner?.emitUserBash !== 'function'
      )
        throw new Error('BASH_UNSUPPORTED');
      const before = identity(session);
      assertIdentity(expected, before);
      beforeDispatch?.();
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
      await onResult(nativeBashResult(result));
      return nativeBashResult(result);
    },
    stop: async ({ onWithdraw, ...expected } = {}) => {
      if (
        typeof onWithdraw !== 'function' ||
        !['clearQueue', 'abort', 'abortBash'].every((name) => typeof session[name] === 'function')
      )
        throw new Error('STOP_UNSUPPORTED');
      const before = identity(session);
      assertIdentity(expected, before);
      const withdrawn = session.clearQueue(),
        cancellation = tracked.track(session.abort());
      try {
        session.abortBash();
        await onWithdraw(withdrawn);
        await cancellation;
      } finally {
        // Keep adapter admission/release fenced even when capture fails first.
        // allSettled preserves that failure if cancellation also rejects.
        await Promise.allSettled([cancellation]);
      }
      assertIdentity(before, identity(session));
      await onWithdraw(session.clearQueue());
      return stopReceipt({
        status: 'accepted',
        acknowledgement: 'native_ack',
        coverage: 'agent_and_bash',
      });
    },
    ...(tracked.release
      ? {
          ...(['clearQueue', 'abort', 'abortBash'].every(
            (name) => typeof session[name] === 'function',
          )
            ? {
                cancel: async () => {
                  session.clearQueue();
                  const cancellation = session.abort();
                  session.abortBash();
                  await cancellation;
                },
              }
            : {}),
          release: tracked.release,
        }
      : {}),
  };
}

export function createRpcHostBinding(client, { release, reload, onError } = {}) {
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
    compact:
      typeof client.compact === 'function'
        ? async ({ instructions, interrupt, beforeDispatch, ...expected }) => {
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
          }
        : undefined,
    setModel: ['getAvailableModels', 'setModel', 'setThinkingLevel'].every(
      (name) => typeof client[name] === 'function',
    )
      ? createModelSetter({
          state,
          models: () => client.getAvailableModels(),
          setModel: (model) => tracked.track(client.setModel(model.provider, model.id)),
          setThinkingLevel: (level) => tracked.track(client.setThinkingLevel(level)),
        })
      : undefined,
    submit: async ({ text, images, model, thinking_level, mode = 'steer', beforeDispatch }) => {
      if (hasPromptSettings({ model, thinking_level }))
        throw new Error('MODEL_SELECTION_UNSUPPORTED');
      if (!SEND_MODES.includes(mode)) throw new Error('INVALID_HOST_SUBMISSION');
      if (mode === 'idle_only') {
        const observed = await state();
        if (observed.isStreaming || observed.isCompacting || observed.pendingMessageCount > 0)
          return { status: 'skipped', reason: 'busy' };
      }
      beforeDispatch?.();
      try {
        const disposition = await tracked.track(
          client.prompt(text, images, options(mode).streamingBehavior),
        );
        if (!['started', 'queued', 'handled'].includes(disposition)) return unknown();
        return { status: 'accepted', disposition };
      } catch (error) {
        // Official RpcClient exposes both negative ACKs and transport failures
        // as plain Errors. Never infer rejection by parsing a raw error string.
        return unknown();
      }
    },
    bash: async ({ command, onResult, beforeDispatch, ...expected }) => {
      if (
        typeof onResult !== 'function' ||
        !['bash', 'clearQueue', 'abort', 'abortBash'].every(
          (name) => typeof client[name] === 'function',
        )
      )
        throw new Error('BASH_UNSUPPORTED');
      const before = await state();
      assertIdentity(expected, before);
      beforeDispatch?.();
      const result = await tracked.track(client.bash(command));
      assertIdentity(before, await state());
      await onResult(nativeBashResult(result));
      return nativeBashResult(result);
    },
    stop: async ({ onWithdraw, ...expected } = {}) => {
      if (
        typeof onWithdraw !== 'function' ||
        !['clearQueue', 'abort', 'abortBash'].every((name) => typeof client[name] === 'function')
      )
        throw new Error('STOP_UNSUPPORTED');
      const before = await state();
      assertIdentity(expected, before);
      const result = await tracked.track(
        requestRpcStop(client, async (value) => {
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
            await requestRpcStop(client, async () => {});
          },
          release: tracked.release,
        }
      : {}),
  };
}
