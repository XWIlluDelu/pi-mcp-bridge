import { z } from 'zod';
export const compactSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    instructions: z.string().max(100000).optional(),
    interrupt: z.boolean().optional(),
    timeout_ms: z.number().int().min(50).max(30000).optional(),
  })
  .strict();
export const compactInputSchema = compactSchema.omit({ session_id: true, timeout_ms: true });

// Native public APIs can interrupt but cannot attest unrelated input preflight.
// A host with its own admission gate can implement idle compact separately.
export function requireInterruptCompaction(input, state) {
  if (input.interrupt) return;
  if (
    state.isIdle === false ||
    state.isStreaming === true ||
    state.isCompacting === true ||
    state.pendingMessageCount > 0 ||
    state.hasPendingMessages === true
  )
    throw new Error('COMPACT_BUSY');
  throw new Error('COMPACT_IDLE_UNCONFIRMED');
}
export function compactMetadata(value) {
  compactReceipt(value);
  return Object.fromEntries(
    ['firstKeptEntryId', 'tokensBefore', 'estimatedTokensAfter']
      .filter((key) => value[key] !== undefined)
      .map((key) => [key, value[key]]),
  );
}
// Compaction summaries contain read-protected history. Return only a bounded
// completion receipt; clients with read permission can inspect the native entry.
export function compactReceipt(value) {
  if (
    typeof value?.firstKeptEntryId !== 'string' ||
    value.firstKeptEntryId.length > 128 ||
    !Number.isSafeInteger(value.tokensBefore) ||
    value.tokensBefore < 0
  )
    throw Object.assign(new Error('INVALID_COMPACT_RESULT'), { uncertain: true });
  return {
    status: 'accepted',
    completion: 'completed',
    first_kept_entry_id: value.firstKeptEntryId,
    tokens_before: value.tokensBefore,
    estimated_tokens_after:
      Number.isSafeInteger(value.estimatedTokensAfter) && value.estimatedTokensAfter >= 0
        ? value.estimatedTokensAfter
        : null,
  };
}
