import { modelSelectionSchema, thinkingLevelSchema } from './models.mjs';

export function modelSettings(value) {
  const model = modelSelectionSchema.safeParse({
      provider: value?.model?.provider,
      id: value?.model?.id,
    }),
    thinking = thinkingLevelSchema.safeParse(value?.thinking_level);
  if (!model.success || !thinking.success) throw new Error('INVALID_MODEL_SELECTION');
  return { model: model.data, thinking_level: thinking.data };
}
