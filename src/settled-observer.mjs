import { ownerRequest } from './owner-runtime.mjs';
import { hash, opaqueId } from './storage.mjs';
import { captureSettledResult } from './settled-result.mjs';

// Shared native boundary capture for owned RPC and the ordinary companion.
export class SettledObserver {
  constructor(control, generation, lifecycle = {}) {
    this.control = control;
    this.generation = generation;
    this.lifecycle = lifecycle;
  }
  start(manager) {
    // Automatic continuations can start another loop before one run settles.
    if (this.lifecycle.runStartLeaf === undefined)
      this.lifecycle.runStartLeaf = manager.getLeafId();
  }
  capture(event, manager) {
    const result = captureSettledResult(manager, this.lifecycle.runStartLeaf);
    this.lifecycle.runStartLeaf = undefined;
    return {
      op: 'settled',
      session_id: opaqueId(manager.getSessionFile() + '\0' + manager.getSessionId()),
      sessionCwdHash: hash(manager.getHeader().cwd ?? null),
      generation: this.generation,
      sequence: (this.lifecycle.completionSequence = (this.lifecycle.completionSequence ?? 0) + 1),
      leafId: manager.getLeafId(),
      aborted: event.aborted,
      result,
      timestamp: new Date().toISOString(),
    };
  }
  send(occurrence) {
    // Local acknowledgement is bounded. HTTPS delivery belongs to Bridge;
    // a stopped Bridge must not interrupt normal local Pi work.
    return ownerRequest(this.control, occurrence, {
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  }
}
