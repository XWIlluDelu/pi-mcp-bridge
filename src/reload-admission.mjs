// Pi's isIdle excludes asynchronous input preparation and standalone bash.
// Observe public operation lifetimes. Reload admission is temporary; an owned
// runtime's shutdown seal is terminal. State survives factory replacement.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const key = Symbol.for('pi-mcp-bridge.reload-admission');
const methods = [
  'prompt',
  'sendUserMessage',
  'steer',
  'followUp',
  'sendCustomMessage',
  'executeBash',
  'compact',
  'setModel',
  'cycleModel',
  'navigateTree',
  'reload',
];
export function reloadAdmission(AgentSession) {
  let shared = AgentSession[key];
  const install = !shared;
  if (!shared) {
    shared = { sessions: new WeakMap(), scope: new AsyncLocalStorage() };
    Object.defineProperty(AgentSession, key, { value: shared });
  }
  const { sessions, scope } = shared;
  function state(manager) {
    let value = sessions.get(manager);
    if (!value)
      sessions.set(
        manager,
        (value = { pending: 0, reload: null, completed: false, sealed: false }),
      );
    return value;
  }
  const busy = (current, ctx, otherBusy) =>
    current.reload ||
    current.pending ||
    otherBusy ||
    ctx.isIdle() !== true ||
    ctx.hasPendingMessages() !== false;
  // Keep wrappers in their original position in Pi's method chain. Reload only
  // replaces the implementation they delegate to, preserving other observers.
  shared.invoke = async (session, name, args, original) => {
    const current = state(session.sessionManager);
    if (current.sealed) {
      // Native shutdown hooks may append their final message synchronously.
      // Preserve only that branch; queued messages and new runs remain closed.
      if (
        name === 'sendCustomMessage' &&
        session.isStreaming === false &&
        !args[1]?.triggerTurn &&
        args[1]?.deliverAs !== 'nextTurn'
      )
        return original.apply(session, args);
      throw new Error('RUNTIME_SHUTTING_DOWN');
    }
    const internal =
      ['prompt', 'sendUserMessage'].includes(name) && current.reload?.command === args[0];
    if (internal) return original.apply(session, args);
    if (current.reload && scope.getStore() !== current.reload)
      throw new Error('RELOAD_IN_PROGRESS');
    current.pending++;
    try {
      return await original.apply(session, args);
    } finally {
      current.pending--;
      if (!current.pending && !current.sealed) {
        try {
          current.onIdle?.();
        } catch {} // Maintenance notification cannot change a native result.
      }
    }
  };
  if (install)
    for (const name of methods) {
      const original = AgentSession.prototype[name];
      if (typeof original !== 'function') continue;
      AgentSession.prototype[name] = function (...args) {
        return shared.invoke(this, name, args, original);
      };
    }
  const admission = {
    idle: (manager) =>
      state(manager).pending === 0 && !state(manager).reload && !state(manager).sealed,
    completed: (manager) => state(manager).completed,
    reloading: (manager) => Boolean(state(manager).reload),
    sealed: (manager) => state(manager).sealed,
    setOnIdle(manager, callback) {
      state(manager).onIdle = callback;
    },
    seal(manager, ctx, otherBusy = false) {
      const current = state(manager);
      if (current.sealed) return true;
      if (busy(current, ctx, otherBusy)) return false;
      current.sealed = true;
      return true;
    },
    begin(manager, ctx, otherBusy = false) {
      const current = state(manager);
      if (current.sealed) throw new Error('RUNTIME_SHUTTING_DOWN');
      if (busy(current, ctx, otherBusy)) throw new Error('RELOAD_BUSY');
      const token = randomUUID();
      let started = false;
      const timer = setTimeout(() => {
        if (!started) operation.cancel();
      }, 5000);
      timer.unref();
      const operation = {
        token,
        command: `/bridge-reload ${token}`,
        cancel() {
          clearTimeout(timer);
          if (current.reload === operation) current.reload = null;
        },
        async run(reload) {
          if (started || current.reload !== operation) return;
          started = true;
          clearTimeout(timer);
          try {
            const result = await scope.run(operation, reload);
            current.completed = true;
            return result;
          } finally {
            operation.cancel();
          }
        },
      };
      current.completed = false;
      current.reload = operation;
      return operation;
    },
  };
  return admission;
}
