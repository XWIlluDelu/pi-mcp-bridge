// Observe public SDK input calls in a Bridge-owned RPC process. Native dispatch,
// results and errors stay with Pi; only outstanding Promise lifetimes are counted.
const key = Symbol.for('pi-mcp-bridge.rpc-input-activity');

export function observeRpcInputs(AgentSession, onChange) {
  if (!AgentSession[key]) {
    const activity = { sessions: new WeakMap(), onChange };
    for (const name of ['prompt', 'steer', 'followUp', 'sendCustomMessage']) {
      const dispatch = AgentSession.prototype[name];
      AgentSession.prototype[name] = function (...args) {
        const manager = this.sessionManager;
        let state = activity.sessions.get(manager);
        if (!state) {
          state = { pendingInputs: 0, sequence: 0 };
          activity.sessions.set(manager, state);
        }
        const change = (delta) => {
          state.pendingInputs += delta;
          state.sequence++;
          activity.onChange(manager, { ...state });
        };
        change(1);
        try {
          return Promise.resolve(dispatch.apply(this, args)).finally(() => change(-1));
        } catch (error) {
          change(-1);
          throw error;
        }
      };
    }
    Object.defineProperty(AgentSession, key, { value: activity });
  }
  const activity = AgentSession[key];
  activity.onChange = onChange;
  return (manager) => ({
    ...(activity.sessions.get(manager) ?? { pendingInputs: 0, sequence: 0 }),
  });
}
