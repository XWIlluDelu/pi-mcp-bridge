import { z } from 'zod';
export const SEND_MODES = ['default', 'idle_only', 'steer', 'follow_up'];
const promptSchema = z.object({ text: z.string().min(1).max(100000).optional() });
export function promptInput(args) {
  const parsed = promptSchema.safeParse({ text: args.text });
  if (!parsed.success) throw new Error('INVALID_PROMPT_INPUT');
  return parsed.data.text === undefined ? undefined : parsed.data;
}
export function attachedPromptInput(args) {
  const input = promptInput(args);
  if (!input) throw new Error('INVALID_ATTACHED_SEND');
  return input;
}
