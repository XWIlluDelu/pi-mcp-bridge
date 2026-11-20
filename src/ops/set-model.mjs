import { z } from 'zod';
import { modelSelectionSchema, modelState, thinkingLevelSchema, sameModel } from './models.mjs';

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
  const { model, thinkingLevel } = modelState({
    model: value?.model,
    thinkingLevel: value?.thinking_level,
  });
  if (!model || !thinkingLevel) throw new Error('INVALID_MODEL_SELECTION');
  return { model, thinking_level: thinkingLevel };
}

// Both owner paths keep the current effort when switching model and report
// Pi's actual selection. The caller supplies its native admission and ACKs.
export async function applyModelSettings(
  selected,
  target,
  level,
  { setModel, setThinkingLevel, refresh, validate },
) {
  if (!target && !selected.model) throw new Error('MODEL_UNAVAILABLE');
  if (target && !sameModel(selected.model, target)) {
    level ??= selected.thinkingLevel;
    selected = await setModel(target, level);
  } else if (refresh) selected = await refresh();
  if (target && !sameModel(selected.model, target)) throw new Error('MODEL_SELECTION_CHANGED');
  validate?.(selected.model);
  if (level !== undefined && selected.thinkingLevel !== level) {
    selected = await setThinkingLevel(level);
    if (target && !sameModel(selected.model, target)) throw new Error('MODEL_SELECTION_CHANGED');
  }
  return modelSettings({ model: selected.model, thinking_level: selected.thinkingLevel });
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
      let selected = await checked(),
        target;
      if (model) {
        target = (await models()).find((candidate) => sameModel(candidate, model));
        if (!target) throw new Error('MODEL_UNAVAILABLE');
        selected = await checked();
      }
      const before = async () => {
        await beforeDispatch?.();
        dispatched = true;
      };
      return await applyModelSettings(selected, target, thinking_level, {
        async setModel(target, level) {
          if (!thinkingLevelSchema.safeParse(level).success)
            throw new Error('INVALID_MODEL_SELECTION');
          await before();
          if ((await setModel(target)) === false) throw new Error('MODEL_UNAVAILABLE');
          return checked();
        },
        async setThinkingLevel(level) {
          await before();
          await setThinkingLevel(level);
          return checked();
        },
      });
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
