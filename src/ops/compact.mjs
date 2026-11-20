import { z } from 'zod';
import { parseAs, utf16String } from '../mcp/schema.mjs';
export const compactSchema = z.strictObject({
  session_id: utf16String(128).min(1),
  instructions: utf16String(100000).optional(),
  interrupt: z.boolean().optional(),
});
const compactInputSchema = compactSchema.omit({ session_id: true });
export const parseCompactInput = (body) => parseAs(compactInputSchema, body, 'INVALID_ARGUMENTS');

// Exact native messages only: never forward provider, extension or history text.
export function nativeCompactReason(message) {
  if (
    [
      'Nothing to compact (session too small)',
      'Already compacted',
      'Compaction cancelled',
    ].includes(message)
  )
    return message;
}

export function compactContext(ctx, customInstructions) {
  return new Promise((onComplete, reject) =>
    ctx.compact({
      customInstructions,
      onComplete,
      onError: ({ message }) =>
        reject(
          Object.assign(new Error('PI_REJECTED'), { native_reason: nativeCompactReason(message) }),
        ),
    }),
  );
}

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
  if (
    typeof value?.firstKeptEntryId !== 'string' ||
    value.firstKeptEntryId.length > 128 ||
    !Number.isSafeInteger(value.tokensBefore) ||
    value.tokensBefore < 0
  )
    throw Object.assign(new Error('INVALID_COMPACT_RESULT'), { uncertain: true });
  const { firstKeptEntryId, tokensBefore, estimatedTokensAfter } = value;
  return {
    firstKeptEntryId,
    tokensBefore,
    ...(estimatedTokensAfter !== undefined ? { estimatedTokensAfter } : {}),
  };
}
// Compaction summaries contain read-protected history. Return only a bounded
// completion receipt; clients with read permission can inspect the native entry.
export function compactReceipt(value) {
  const { firstKeptEntryId, tokensBefore, estimatedTokensAfter } = compactMetadata(value);
  return {
    status: 'completed',
    first_kept_entry_id: firstKeptEntryId,
    tokens_before: tokensBefore,
    estimated_tokens_after:
      Number.isSafeInteger(estimatedTokensAfter) && estimatedTokensAfter >= 0
        ? estimatedTokensAfter
        : null,
  };
}
