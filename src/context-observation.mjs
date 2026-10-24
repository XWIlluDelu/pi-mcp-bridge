// Passive request-stage observations. No Pi/extension imports or memory-store access.
import { randomUUID } from 'node:crypto';
import { appendUnits, READ_CONTRACT, READ_SNAPSHOT_LIMIT } from './context-read.mjs';
import { jsonBytes } from './response-budget.mjs';
import { sessionEntryIndex } from './data.mjs';
import { readSchema } from './read-schema.mjs';

export function unavailableObservation(sessionId, reason, captureSequence = 0) {
  return {
    contract: READ_CONTRACT,
    view: 'runtime',
    capture_sequence: captureSequence, // Internal IPC ordering; never rendered in public pages.
    session_id: sessionId,
    leaf_id: null,
    selection: null,
    omissions: null,
    units: [],
    observation: { available: false, reason },
    live: null,
  };
}

// The input leaf must still belong to the active native branch. Native history
// is append-only; do not retain raw entries or compute full-history fingerprints.
export function checkObservation(snapshot, data, { ownerActive = true } = {}) {
  if (!snapshot?.observation?.available) return snapshot;
  const input = snapshot.observation.input_leaf_id,
    current = data.leafId,
    byId = sessionEntryIndex(data.entries, current);
  let leaf = current,
    later = 0;
  while (leaf !== input && leaf !== null) {
    const entry = byId.get(leaf);
    if (!entry) break;
    leaf = entry.parentId ?? null;
    later++;
  }
  if (leaf !== input)
    return unavailableObservation(
      snapshot.session_id,
      'input_branch_changed',
      snapshot.capture_sequence,
    );
  return {
    ...snapshot,
    observation: {
      ...snapshot.observation,
      current_leaf_id: current,
      later_committed_entries: later,
      checked_at: new Date().toISOString(),
      owner_active: ownerActive,
    },
  };
}

export class ContextObservation {
  constructor(generation, counter = { captureSequence: 0 }) {
    this.generation = generation;
    this.counter = counter;
  }
  reset() {
    this.counter.captureSequence++;
    this.latest = null;
    this.binding = null;
  }
  capture(event, ctx) {
    const manager = ctx.sessionManager;
    this.binding = { file: manager.getSessionFile(), native_id: manager.getSessionId() };
    const leaf = manager.getLeafId();
    // Replace even a failed/oversized capture: an old observation must not
    // silently masquerade as the newest request.
    const sequence = ++this.counter.captureSequence;
    this.latest = unavailableObservation(null, 'capture_failed', sequence);
    try {
      const target = { units: [], accountedBytes: 0 };
      for (const [index, message] of event.messages.entries()) {
        const type =
          {
            user: 'prompt',
            system: 'system',
            assistant: 'assistant',
            toolResult: 'tool_result',
            compactionSummary: 'summary',
            branchSummary: 'summary',
            bashExecution: 'command',
            custom: 'custom',
          }[message.role] ?? 'native';
        appendUnits(target, { type, source: { observation_index: index }, message });
      }
      this.latest = {
        contract: READ_CONTRACT,
        view: 'runtime',
        capture_sequence: sequence,
        session_id: null,
        leaf_id: leaf,
        selection: null,
        omissions: null,
        units: target.units,
        observation: {
          available: true,
          id: randomUUID(),
          phase: 'context_with_system_observer',
          observed_at: new Date().toISOString(),
          owner_generation: this.generation,
          input_leaf_id: leaf,
        },
        live: null,
      };
    } catch (error) {
      this.latest = unavailableObservation(
        null,
        error.message === 'READ_SNAPSHOT_TOO_LARGE'
          ? 'capture_capacity_exceeded'
          : 'capture_failed',
        sequence,
      );
    }
  }
  read(args, ctx) {
    if (!readSchema.safeParse(args).success || args.view !== 'runtime' || args.cursor !== undefined)
      throw new Error('INVALID_READ_ARGUMENTS');
    const manager = ctx.sessionManager;
    if (!this.latest) {
      const unavailable = unavailableObservation(
        args.session_id,
        'no_observation',
        this.counter.captureSequence,
      );
      // The current branch is not a capture. It lets Bridge validate a retained
      // snapshot without mistaking the saved tail for a live owner's active leaf.
      unavailable.observation.current_leaf_id = manager.getLeafId();
      return unavailable;
    }
    if (
      this.binding.file !== manager.getSessionFile() ||
      this.binding.native_id !== manager.getSessionId()
    )
      return unavailableObservation(
        args.session_id,
        'session_changed',
        this.counter.captureSequence,
      );
    return checkObservation(
      { ...this.latest, session_id: args.session_id },
      { entries: manager.getEntries(), leafId: manager.getLeafId() },
    );
  }
}

// Latest successful capture per session, bounded across owned tasks. Kept by Bridge, not the
// short-lived Pi child. Frozen read cursors may share these sanitized units.
export class RetainedObservations {
  constructor({ maxBytes = READ_SNAPSHOT_LIMIT, maxEntries = 16 } = {}) {
    Object.assign(this, { maxBytes, maxEntries, accountedBytes: 0, entries: new Map() });
  }
  delete(id) {
    const entry = this.entries.get(id);
    if (entry) this.accountedBytes -= entry.bytes;
    this.entries.delete(id);
  }
  put(session, snapshot, runtime) {
    if (!Number.isSafeInteger(snapshot.capture_sequence) || snapshot.capture_sequence < 0)
      throw new Error('INVALID_OWNER_READ');
    // Keep the high-water mark on the live runtime, not an evictable cache entry.
    // Failed captures advance it too; an older successful read cannot revive them.
    if (snapshot.capture_sequence < (runtime.retainedObservationSequence ?? -1)) return;
    runtime.retainedObservationSequence = snapshot.capture_sequence;
    // Lifecycle/status replies are not captures. Keep the last actual request
    // with its original identity; a failed live capture is reported by that read.
    if (!snapshot.observation.available) return;
    this.delete(session.id);
    const bytes = jsonBytes(snapshot) * 4 + snapshot.units.length * 256;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    while (this.entries.size >= this.maxEntries || this.accountedBytes + bytes > this.maxBytes)
      this.delete(this.entries.keys().next().value);
    this.entries.set(session.id, {
      file: session.file,
      nativeId: session.header.id,
      cwd: session.header.cwd,
      snapshot,
      bytes,
    });
    this.accountedBytes += bytes;
  }
  get(session) {
    const entry = this.entries.get(session.id);
    if (!entry) return unavailableObservation(session.id, 'no_retained_observation');
    if (
      entry.file !== session.file ||
      entry.nativeId !== session.header.id ||
      entry.cwd !== session.header.cwd
    ) {
      this.delete(session.id);
      return unavailableObservation(session.id, 'session_changed');
    }
    this.entries.delete(session.id);
    this.entries.set(session.id, entry);
    return entry.snapshot;
  }
  clear() {
    this.entries.clear();
    this.accountedBytes = 0;
  }
}
