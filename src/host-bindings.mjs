// Bind existing owners through Pi 1.1 public APIs. These helpers never open a
// session, spawn a process, read stdio, or access private admission hooks.
import { nativeBashResult } from './bash-execution.mjs';
import { SEND_MODES, assertImageModel } from './prompt-input.mjs';
import { modelPage, sameModel, assertThinkingLevel, modelSetting } from './models.mjs';
import { requestRpcStop, stopReceipt } from './stop-execution.mjs';
const unknown = () => ({
  status: 'unknown',
  dispatch: 'submitted',
  reason: 'PI_ACCEPTANCE_UNOBSERVABLE',
  completion: 'not_tracked',
});
const options = (mode) =>
  ['default', 'steer'].includes(mode)
    ? { streamingBehavior: 'steer' }
    : mode === 'follow_up'
      ? { streamingBehavior: 'followUp' }
      : {};
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
            await Promise.allSettled([...pending]);
            return { released: true };
          },
        }
      : {}),
  };
}

export function createSdkHostBinding(session, { release, onError } = {}) {
  const tracked = tracker(release, onError);
  const state = async () => ({
    ...identity(session),
    isIdle: session.isIdle,
    isStreaming: session.isStreaming,
    isCompacting: session.isCompacting,
    pendingMessageCount: session.pendingMessageCount,
  });
  return {
    state,
    snapshot: async () => {
      const before = identity(session);
      const entries = structuredClone(session.sessionManager.getEntries()),
        leafId = session.sessionManager.getLeafId();
      assertIdentity(before, identity(session));
      return { ...before, entries, leafId };
    },
    supportsImages: true,
    models:
      typeof session.modelRuntime?.getAvailableSnapshot === 'function'
        ? async (args) =>
            modelPage(
              session.modelRuntime.getAvailableSnapshot(),
              session.model,
              session.thinkingLevel,
              args,
            )
        : undefined,
    selectModel:
      typeof session.setModel === 'function'
        ? async ({ model, thinking_level, beforeDispatch }) => {
            const target = session.modelRuntime
              .getAvailableSnapshot()
              .find((m) => sameModel(m, model ?? session.model));
            if (!target) throw new Error('MODEL_UNAVAILABLE');
            assertThinkingLevel(target, thinking_level);
            if (thinking_level !== undefined && typeof session.setThinkingLevel !== 'function')
              throw new Error('THINKING_LEVEL_UNSUPPORTED');
            const previous = session.thinkingLevel;
            beforeDispatch?.();
            try {
              if (model && !sameModel(session.model, target))
                await session.setModel(target, { persist: false });
              beforeDispatch?.();
              if (thinking_level !== undefined)
                session.setThinkingLevel(thinking_level, { persist: false });
            } catch {
              throw Object.assign(new Error('MODEL_SELECTION_FAILED'), { uncertain: true });
            }
            return modelSetting(session.model, session.thinkingLevel, previous, thinking_level);
          }
        : undefined,
    submit: async ({ text, images, model, mode = 'default', beforeDispatch }) => {
      if (model) throw new Error('MODEL_SELECTION_UNSUPPORTED');
      if (!SEND_MODES.includes(mode)) throw new Error('INVALID_HOST_SUBMISSION');
      assertImageModel(images, session.model);
      beforeDispatch?.();
      if (mode === 'idle_only' && !session.isIdle) return { status: 'skipped', reason: 'busy' };
      // Public prompt() resolves at completion, not at admission. Even a
      // synchronous throw after entering host code cannot prove no side effect.
      try {
        tracked.track(session.prompt(text, { ...options(mode), ...(images ? { images } : {}) }));
      } catch (error) {
        try {
          onError?.(error);
        } catch {}
      }
      return unknown();
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
      return { completed: true };
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
      session.abortBash();
      await onWithdraw(withdrawn);
      await cancellation;
      assertIdentity(before, identity(session));
      await onWithdraw(session.clearQueue());
      return stopReceipt({ acknowledgement: 'native_ack', coverage: 'agent_and_bash' });
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

export function createRpcHostBinding(client, { release, onError } = {}) {
  let selectionUnconfirmed = false;
  const tracked = tracker(release, onError);
  const state = async () => {
    const value = await client.getState();
    return {
      ...identity(value),
      isStreaming: value.isStreaming,
      isCompacting: value.isCompacting,
      pendingMessageCount: value.pendingMessageCount,
    };
  };
  return {
    state,
    snapshot: async () => {
      const before = await state(),
        snapshot = await client.getEntries(),
        after = await state();
      assertIdentity(before, after);
      return {
        ...identity(after),
        entries: structuredClone(snapshot.entries),
        leafId: snapshot.leafId,
      };
    },
    supportsImages: true,
    models:
      typeof client.getAvailableModels === 'function'
        ? async (args) => {
            const models = await client.getAvailableModels(),
              state = await client.getState();
            return modelPage(models, state.model, state.thinkingLevel, args);
          }
        : undefined,
    selectModel:
      typeof client.setModel === 'function'
        ? async ({ model, thinking_level, beforeDispatch }) => {
            if (selectionUnconfirmed) throw new Error('MODEL_SELECTION_PENDING');
            const initial = await client.getState();
            const target = (await client.getAvailableModels()).find((m) =>
              sameModel(m, model ?? initial.model),
            );
            if (!target) throw new Error('MODEL_UNAVAILABLE');
            assertThinkingLevel(target, thinking_level);
            if (thinking_level !== undefined && typeof client.setThinkingLevel !== 'function')
              throw new Error('THINKING_LEVEL_UNSUPPORTED');
            beforeDispatch?.();
            try {
              if (model && !sameModel(initial.model, target))
                await tracked.track(client.setModel(target.provider, target.id));
              beforeDispatch?.();
              if (thinking_level !== undefined)
                await tracked.track(client.setThinkingLevel(thinking_level));
              const selected = await client.getState();
              return modelSetting(
                selected.model,
                selected.thinkingLevel,
                initial.thinkingLevel,
                thinking_level,
              );
            } catch {
              // RpcClient's plain Error cannot distinguish a negative ACK from a
              // timed-out command still running. Don't let new input race a late set.
              selectionUnconfirmed = true;
              throw Object.assign(new Error('MODEL_SELECTION_FAILED'), { uncertain: true });
            }
          }
        : undefined,
    submit: async ({ text, images, model, mode = 'default', beforeDispatch }) => {
      if (model) throw new Error('MODEL_SELECTION_UNSUPPORTED');
      if (!SEND_MODES.includes(mode)) throw new Error('INVALID_HOST_SUBMISSION');
      if (selectionUnconfirmed) throw new Error('MODEL_SELECTION_PENDING');
      if (images) assertImageModel(images, (await client.getState()).model);
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
        return { status: 'accepted', disposition, completion: 'not_tracked' };
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
      return { completed: true };
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
