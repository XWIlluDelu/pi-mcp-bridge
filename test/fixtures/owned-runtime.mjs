import { PiRpc } from '../../src/rpc.mjs';
import { nativeBusy, pendingMessages } from '../../src/attachment-protocol.mjs';
// Minimal Bridge-owned runtime double. Like PiRpc, status sampling reads
// idleSnapshot(); here it derives from the double's own state().
export function ownedRuntime(members) {
  return {
    alive: true,
    submitPrompt: PiRpc.prototype.submitPrompt,
    hasPendingAdmission: () => false,
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
