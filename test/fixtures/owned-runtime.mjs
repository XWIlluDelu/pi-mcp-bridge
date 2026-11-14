import { PiRpc } from '../../src/rpc.mjs';
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
        status: state.isStreaming ? 'busy' : state.isIdle === true ? 'idle' : 'unconfirmed',
      };
    },
    ...members,
  };
}
