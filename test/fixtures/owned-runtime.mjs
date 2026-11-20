import { PiRpc } from '../../src/runtime/rpc.mjs';
import { nativeBusy, pendingMessages } from '../../src/runtime/attachment-protocol.mjs';
// Minimal Bridge-owned runtime double. Like PiRpc, status sampling reads
// idleSnapshot(); here it derives from the double's own state().
export function ownedRuntime(members) {
  return {
    alive: true,
    async stop() {
      this.alive = false;
    },
    submitPrompt: PiRpc.prototype.submitPrompt,
    hasPendingCommand: () => false,
    hasUnsettledWork: () => false,
    async idleSnapshot() {
      const state = await this.state();
      return {
        state,
        status:
          this.hasUnsettledWork() || nativeBusy(state)
            ? 'busy'
            : state.isIdle === true
              ? 'idle'
              : 'unknown',
        pending: pendingMessages(state),
      };
    },
    ...members,
  };
}
