import { z } from 'zod';
import { resolvePiInstallation, loadPiAi } from './pi-installation.mjs';

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
export async function assertThinkingLevel(model, level, config) {
  if (level === undefined) return;
  if (typeof model?.reasoning !== 'boolean') throw new Error('THINKING_SUPPORT_UNKNOWN');
  const { getSupportedThinkingLevels } = await loadPiAi(await resolvePiInstallation(config));
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
export const modelsSchema = z
  .object({
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
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
const numberOrNull = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const textOrNull = (value) => (typeof value === 'string' && value.length <= 256 ? value : null);

// Allowlist only. Full native Model objects can carry endpoint headers and
// arbitrary provider configuration; never pass them to MCP or owner IPC.
export function modelInfo(model, getSupportedThinkingLevels) {
  if (!modelSelectionSchema.safeParse({ provider: model?.provider, id: model?.id }).success)
    throw new Error('INVALID_MODEL_METADATA');
  const input =
    Array.isArray(model.input) && model.input.every((x) => ['text', 'image'].includes(x))
      ? [...new Set(model.input)]
      : null;
  const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : null;
  return {
    provider: model.provider,
    id: model.id,
    name: textOrNull(model.name),
    input,
    context_window: numberOrNull(model.contextWindow),
    // This is the same native helper used by AgentSession, not a Bridge guess.
    effort: reasoning === null ? null : getSupportedThinkingLevels(model),
  };
}
export function catalogPage(models, args = {}, getSupportedThinkingLevels) {
  if (!Array.isArray(models)) throw new Error('INVALID_MODEL_METADATA');
  const ordered = models
    .map((model) => modelInfo(model, getSupportedThinkingLevels))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const offset = args.offset ?? 0,
    limit = args.limit ?? 30;
  return {
    models: ordered.slice(offset, offset + limit),
    next_offset: offset + limit < ordered.length ? offset + limit : null,
  };
}
