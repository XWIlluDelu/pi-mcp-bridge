import { z } from 'zod';
import { modelSelectionSchema, thinkingLevelSchema, sameModel } from './models.mjs';

export const modelSettingsSchema = z
  .object({
    model: modelSelectionSchema.optional(),
    thinking_level: thinkingLevelSchema.optional(),
  })
  .strict()
  .refine((args) => args.model !== undefined || args.thinking_level !== undefined, {
    message: 'Model or thinking level required',
  });

export function modelSettings(value) {
  const model = modelSelectionSchema.safeParse({
      provider: value?.model?.provider,
      id: value?.model?.id,
    }),
    thinking = thinkingLevelSchema.safeParse(value?.thinking_level);
  if (!model.success || !thinking.success) throw new Error('INVALID_MODEL_SELECTION');
  return { model: model.data, thinking_level: thinking.data };
}

// Bind public native setters without prompt admission.
// Keep a truly unfinished setter fenced even if its IPC caller has disconnected.
export function createModelSetter({ state, models, setModel, setThinkingLevel }) {
  let pending = false;
  const select = async ({ model, thinking_level, sessionFile, sessionId, beforeDispatch }) => {
    if (!modelSettingsSchema.safeParse({ model, thinking_level }).success)
      throw new Error('INVALID_ARGUMENTS');
    if (pending) throw new Error('MODEL_SELECTION_PENDING');
    pending = true;
    let dispatched = false;
    try {
      const checked = async () => {
        const value = await state();
        if (value.sessionFile !== sessionFile || value.sessionId !== sessionId)
          throw new Error('RUNTIME_SESSION_CHANGED');
        return value;
      };
      await checked();
      const target = model ? (await models()).find((m) => sameModel(m, model)) : null;
      if (model && !target) throw new Error('MODEL_UNAVAILABLE');
      let selected = await checked();
      if (!target && !selected.model) throw new Error('MODEL_UNAVAILABLE');
      let level = thinking_level;
      if (target && !sameModel(selected.model, target)) {
        // Model-only changes keep current effort; the native setter owns clamping.
        level ??= selected.thinkingLevel;
        if (!thinkingLevelSchema.safeParse(level).success)
          throw new Error('INVALID_MODEL_SELECTION');
        await beforeDispatch?.();
        dispatched = true;
        if ((await setModel(target)) === false) throw new Error('MODEL_UNAVAILABLE');
        selected = await checked();
      }
      if (target && !sameModel(selected.model, target)) throw new Error('MODEL_SELECTION_CHANGED');
      if (level !== undefined && selected.thinkingLevel !== level) {
        await beforeDispatch?.();
        dispatched = true;
        await setThinkingLevel(level);
        selected = await checked();
      }
      if (target && !sameModel(selected.model, target)) throw new Error('MODEL_SELECTION_CHANGED');
      return modelSettings({ model: selected.model, thinking_level: selected.thinkingLevel });
    } catch (error) {
      if (!/^[A-Z_]{3,64}$/.test(error.message)) error = new Error('MODEL_SELECTION_FAILED');
      if (dispatched) error.uncertain = true;
      throw error;
    } finally {
      pending = false;
    }
  };
  Object.defineProperty(select, 'pending', { get: () => pending });
  return select;
}
