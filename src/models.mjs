import { z } from 'zod';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';

const identifier = z.string().min(1).max(256);
export const modelSelectionSchema = z.object({ provider: identifier, id: identifier }).strict();
export const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export function assertThinkingLevel(model, level) {
  if (level === undefined) return;
  if (typeof model?.reasoning !== 'boolean') throw new Error('THINKING_SUPPORT_UNKNOWN');
  if (!getSupportedThinkingLevels(model).includes(level))
    throw new Error('THINKING_LEVEL_UNSUPPORTED');
}
export function modelSetting(model, level) {
  const identity = modelSelectionSchema.parse({ provider: model?.provider, id: model?.id });
  return {
    model: identity,
    thinking_level: thinkingLevelSchema.safeParse(level).success ? level : null,
  };
}
// Native state is reduced before owner IPC as well as before public list output.
export function modelState(state) {
  const model = modelSelectionSchema.safeParse({
    provider: state?.model?.provider,
    id: state?.model?.id,
  });
  const level = thinkingLevelSchema.safeParse(state?.thinkingLevel);
  return {
    model: model.success ? model.data : null,
    thinkingLevel: level.success ? level.data : null,
  };
}

export const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id;
