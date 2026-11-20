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
    if (methods.some((name) => typeof AgentSession.prototype[name] !== 'function'))
      throw new Error('INVALID_HOST_SESSION');
    shared = { sessions: new WeakMap(), scope: new AsyncLocalStorage() };
    Object.defineProperty(AgentSession, key, { value: shared });
  }
  const { sessions, scope } = shared;
  function state(manager) {
    let value = sessions.get(manager);
    if (!value) sessions.set(manager, (value = { pending: 0, operation: null, completed: false }));
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
    const operation = current.operation;
    if (operation?.kind === 'seal') {
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
      operation?.kind === 'reload' &&
      operation.command === args[0];
    if (internal) return original.apply(session, args);
    // Input-free model changes remain available during compaction. Their hooks
    // keep the caller's scope, so they cannot start work through this gate.
    const settings = operation?.kind === 'compact' && ['setModel', 'cycleModel'].includes(name);
    if (operation && scope.getStore() !== operation && !settings)
      throw new Error(operation.kind === 'reload' ? 'RELOAD_IN_PROGRESS' : 'COMPACTION_PENDING');
    current.pending++;
    try {
      return await original.apply(session, args);
    } finally {
      current.pending--;
      if (!current.pending && current.operation?.kind !== 'seal') {
        try {
          current.onIdle?.();
        } catch {} // Maintenance notification cannot change a native result.
      }
    }
  };
  if (install)
    for (const name of methods) {
      const original = AgentSession.prototype[name];
      AgentSession.prototype[name] = function (...args) {
        return shared.invoke(this, name, args, original);
      };
    }
  function acquire(manager, ctx, otherBusy, kind) {
    const current = state(manager);
    if (current.operation?.kind === 'seal') throw new Error('RUNTIME_SHUTTING_DOWN');
    const reload = kind === 'reload';
    if (busy(current, ctx, otherBusy)) throw new Error(reload ? 'RELOAD_BUSY' : 'COMPACT_BUSY');
    let started = false,
      timer;
    const operation = {
      kind,
      cancel() {
        clearTimeout(timer);
        if (current.operation === operation) current.operation = null;
      },
      async run(work) {
        if (started || current.operation !== operation) return;
        started = true;
        clearTimeout(timer);
        try {
          const result = await scope.run(operation, work);
          if (reload) current.completed = true;
          return result;
        } finally {
          operation.cancel();
        }
      },
    };
    if (reload) {
      current.completed = false;
      operation.token = randomUUID();
      operation.command = `/bridge-reload ${operation.token}`;
      timer = setTimeout(operation.cancel, 5000).unref();
    }
    current.operation = operation;
    return operation;
  }
  return {
    idle(manager) {
      const current = state(manager);
      return current.pending === 0 && !current.operation;
    },
    completed: (manager) => state(manager).completed,
    reloading: (manager) => state(manager).operation?.kind === 'reload',
    sealed: (manager) => state(manager).operation?.kind === 'seal',
    setOnIdle(manager, callback) {
      state(manager).onIdle = callback;
    },
    seal(manager, ctx, otherBusy = false) {
      const current = state(manager);
      if (current.operation?.kind === 'seal') return true;
      if (busy(current, ctx, otherBusy)) return false;
      current.operation = { kind: 'seal' };
      return true;
    },
    async compact(manager, ctx, run, otherBusy = false) {
      // Acquire synchronously before Pi's first await, and retain exclusivity
      // until native completion even if the IPC caller disconnects.
      return acquire(manager, ctx, otherBusy, 'compact').run(run);
    },
    begin(manager, ctx, otherBusy = false) {
      return acquire(manager, ctx, otherBusy, 'reload');
    },
  };
}
