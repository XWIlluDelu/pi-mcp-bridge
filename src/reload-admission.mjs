// Pi's isIdle excludes asynchronous input preparation and standalone bash.
// Observe public operation lifetimes. Reload/idle compact admission is temporary; an owned
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
        (value = { pending: 0, operation: null, completed: false, sealed: false }),
      );
    return value;
  }
  const busy = (current, ctx, otherBusy) =>
    current.operation ||
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
      ['prompt', 'sendUserMessage'].includes(name) &&
      current.operation?.kind === 'reload' &&
      current.operation.command === args[0];
    if (internal) return original.apply(session, args);
    if (current.operation && scope.getStore() !== current.operation)
      throw new Error(
        current.operation.kind === 'reload' ? 'RELOAD_IN_PROGRESS' : 'COMPACTION_PENDING',
      );
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
      state(manager).pending === 0 && !state(manager).operation && !state(manager).sealed,
    completed: (manager) => state(manager).completed,
    reloading: (manager) => state(manager).operation?.kind === 'reload',
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
    async compact(manager, ctx, run, otherBusy = false) {
      const current = state(manager);
      if (current.sealed) throw new Error('RUNTIME_SHUTTING_DOWN');
      if (busy(current, ctx, otherBusy)) throw new Error('COMPACT_BUSY');
      // Acquire synchronously before Pi's first await, and retain exclusivity
      // until native completion even if the IPC caller disconnects.
      const operation = { kind: 'compact' };
      current.operation = operation;
      try {
        return await scope.run(operation, run);
      } finally {
        if (current.operation === operation) current.operation = null;
      }
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
        kind: 'reload',
        token,
        command: `/bridge-reload ${token}`,
        cancel() {
          clearTimeout(timer);
          if (current.operation === operation) current.operation = null;
        },
        async run(reload) {
          if (started || current.operation !== operation) return;
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
      current.operation = operation;
      return operation;
    },
  };
  return admission;
}
