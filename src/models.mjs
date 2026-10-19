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
export const modelSettingsSchema = z
  .object({
    model: modelSelectionSchema.optional(),
    thinking_level: thinkingLevelSchema.optional(),
    timeout_ms: z.number().int().min(50).max(30000).optional(),
  })
  .strict()
  .refine((x) => x.model !== undefined || x.thinking_level !== undefined);
export function assertThinkingLevel(model, level) {
  if (level === undefined) return;
  if (typeof model?.reasoning !== 'boolean') throw new Error('THINKING_SUPPORT_UNKNOWN');
  if (!getSupportedThinkingLevels(model).includes(level))
    throw new Error('THINKING_LEVEL_UNSUPPORTED');
}
export function modelSetting(model, level, previous, requested) {
  const identity = modelSelectionSchema.parse({ provider: model?.provider, id: model?.id });
  return {
    model: identity,
    thinking_level: thinkingLevelSchema.safeParse(level).success ? level : null,
    thinking_adjustment: level !== (requested ?? previous) ? 'native_adjustment' : 'none',
  };
}
export function cleanModelSetting(value) {
  if (
    !modelSelectionSchema.safeParse(value?.model).success ||
    !(
      value.thinking_level === null || thinkingLevelSchema.safeParse(value.thinking_level).success
    ) ||
    !['none', 'native_adjustment', 'unknown'].includes(value.thinking_adjustment)
  )
    throw new Error('INVALID_MODEL_METADATA');
  return {
    model: { provider: value.model.provider, id: value.model.id },
    thinking_level: value.thinking_level,
    thinking_adjustment: value.thinking_adjustment,
  };
}
export const setModelSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    model: modelSelectionSchema.optional(),
    thinking_level: thinkingLevelSchema.optional(),
    timeout_ms: z.number().int().min(50).max(30000).optional(),
  })
  .strict();
export const modelsSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    start: z.boolean().optional(),
    offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export const sameModel = (a, b) => !!a && !!b && a.provider === b.provider && a.id === b.id;
const numberOrNull = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const textOrNull = (value) => (typeof value === 'string' && value.length <= 256 ? value : null);

// Allowlist only. Full native Model objects can carry endpoint headers and
// arbitrary provider configuration; never pass them to MCP or owner IPC.
export function modelInfo(model) {
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
    supports_images: input === null ? null : input.includes('image'),
    context_window: numberOrNull(model.contextWindow),
    max_output_tokens: numberOrNull(model.maxTokens),
    reasoning,
    // This is the same native helper used by AgentSession, not a Bridge guess.
    thinking_levels: reasoning === null ? null : getSupportedThinkingLevels(model),
    input_limits: {
      max_request_bytes: numberOrNull(model.inputLimits?.maxRequestBytes),
      images_per_message: numberOrNull(model.inputLimits?.images?.maxPerMessage),
      images_per_request: numberOrNull(model.inputLimits?.images?.maxPerRequest),
    },
  };
}
export function modelPage(models, current, thinkingLevel, args = {}) {
  if (!Array.isArray(models)) throw new Error('INVALID_MODEL_METADATA');
  const ordered = models
    .map(modelInfo)
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  const offset = args.offset ?? 0,
    limit = args.limit ?? 30;
  return {
    source: 'runtime',
    availability: 'native_snapshot',
    current: current ? { ...modelInfo(current), thinking_level: textOrNull(thinkingLevel) } : null,
    models: ordered.slice(offset, offset + limit),
    total: ordered.length,
    next_offset: offset + limit < ordered.length ? offset + limit : null,
  };
}
// Rebuild owner results field-by-field; an old/custom host is not trusted to
// sanitize model metadata correctly. Unknown fields are deliberately discarded.
export function cleanModelPage(page) {
  const info = (model) => {
    const result = modelInfo({
      provider: model?.provider,
      id: model?.id,
      name: model?.name,
      input: model?.input,
      contextWindow: model?.context_window,
      maxTokens: model?.max_output_tokens,
      reasoning: model?.reasoning,
      inputLimits: {
        maxRequestBytes: model?.input_limits?.max_request_bytes,
        images: {
          maxPerMessage: model?.input_limits?.images_per_message,
          maxPerRequest: model?.input_limits?.images_per_request,
        },
      },
    });
    // Preserve the owner's native helper result, including unknown; do not
    // recompute levels from the deliberately reduced transport metadata.
    if (
      model.thinking_levels !== null &&
      (!Array.isArray(model.thinking_levels) ||
        model.thinking_levels.length > 7 ||
        model.thinking_levels.some(
          (x) => !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(x),
        ))
    )
      throw new Error('INVALID_MODEL_METADATA');
    result.thinking_levels = model.thinking_levels;
    return result;
  };
  if (
    page?.source !== 'runtime' ||
    page.availability !== 'native_snapshot' ||
    !Array.isArray(page.models) ||
    page.models.length > 100 ||
    !Number.isSafeInteger(page.total) ||
    page.total < page.models.length ||
    !(
      page.next_offset === null ||
      (Number.isSafeInteger(page.next_offset) && page.next_offset >= 0)
    )
  )
    throw new Error('INVALID_MODEL_METADATA');
  return {
    source: 'runtime',
    availability: 'native_snapshot',
    current: page.current
      ? { ...info(page.current), thinking_level: textOrNull(page.current.thinking_level) }
      : null,
    models: page.models.map(info),
    total: page.total,
    next_offset: page.next_offset,
  };
}
