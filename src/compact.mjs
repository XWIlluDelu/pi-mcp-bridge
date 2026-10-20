import { z } from 'zod';
export const compactSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    instructions: z.string().max(100000).optional(),
    recover: z.literal(true).optional(),
    interrupt: z.boolean().optional(),
    timeout_ms: z.number().int().min(50).max(30000).optional(),
  })
  .strict();
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
