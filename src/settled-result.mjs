import { z } from 'zod';
import { jsonBytes } from './response-budget.mjs';

// Leave room for identity/framing in the owner control channel's 8 KiB request.
export const SETTLED_RESULT_LIMIT = 4096;
const MAX_TEXT = 2048;
export const settledResultSchema = z
  .object({
    entry_id: z.string().min(1).max(128),
    text: z.string().max(MAX_TEXT),
    stop_reason: z.string().min(1).max(64).nullable(),
    truncated: z.boolean(),
  })
  .strict()
  .nullable()
  .refine((value) => jsonBytes(value) <= SETTLED_RESULT_LIMIT);

function excerpt(text, limit) {
  if (text.length <= limit) return text;
  if (limit < 5) return '';
  let head = Math.floor((limit - 3) * 0.65),
    tail = text.length - (limit - 3 - head);
  if (/[\uD800-\uDBFF]/u.test(text[head - 1] ?? '')) head--;
  if (/[\uDC00-\uDFFF]/u.test(text[tail] ?? '')) tail++;
  return `${text.slice(0, head)}\n…\n${text.slice(tail)}`;
}

// Same native projection used by Session Context. Capture synchronously at the
// settlement boundary, never from a later read, stream delta or memory reader.
export function captureSettledResult(manager, startLeaf) {
  if (startLeaf === undefined) return null; // No observed start; never guess a run.
  const branch = manager.getBranch();
  const start = startLeaf === null ? -1 : branch.findIndex((entry) => entry.id === startLeaf);
  if (startLeaf !== null && start === -1) return null;
  const currentIds = new Set(branch.slice(start + 1).map((entry) => entry.id));
  const entries = manager.buildSessionProjection().entries;
  for (let i = entries.length - 1; i >= 0; i--) {
    const { sourceEntry, messages } = entries[i];
    if (!currentIds.has(sourceEntry.id)) continue;
    for (let j = messages.length - 1; j >= 0; j--) {
      const message = messages[j];
      if (message.role !== 'assistant') continue;
      const text = (Array.isArray(message.content) ? message.content : [])
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
      const make = (limit) => ({
        entry_id: sourceEntry.id,
        text: excerpt(text, limit),
        stop_reason: message.stopReason ?? null,
        truncated: text.length > limit,
      });
      let low = 0,
        high = Math.min(MAX_TEXT, text.length);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (jsonBytes(make(mid)) <= SETTLED_RESULT_LIMIT) low = mid;
        else high = mid - 1;
      }
      return settledResultSchema.parse(make(low));
    }
  }
  return null;
}
