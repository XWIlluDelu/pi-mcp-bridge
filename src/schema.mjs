import { z } from 'zod';

// Bridge string limits use UTF-16 code units.
// Zod's maxLength measures code points; retain our UTF-16 limit as well.
export function utf16String(max, { trim = false } = {}) {
  const schema = trim ? z.string().trim() : z.string();
  return schema.max(max).refine((value) => value.length <= max, {
    message: `Must contain at most ${max} UTF-16 code units`,
  });
}
