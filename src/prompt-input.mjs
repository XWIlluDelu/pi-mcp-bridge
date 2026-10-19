import { z } from 'zod';
import { modelSelectionSchema } from './models.mjs';

// Fit a complete base64 prompt (including text/JSON overhead) into the existing
// 8 MiB MCP/IPC request bound. No URL fetching or local-path access is implied.
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const SEND_MODES = ['default', 'idle_only', 'steer', 'follow_up'];
const MAX_BASE64 = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);
const mimeTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
function matchesMime(bytes, mime) {
  if (mime === 'image/png')
    return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (mime === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
const imageSchema = z
  .object({
    type: z.literal('image'),
    data: z
      .string()
      .min(1)
      .max(MAX_BASE64)
      .describe('Canonical base64 image bytes, not a data URL, URL, file path or attachment ID.'),
    mimeType: z.enum(mimeTypes),
  })
  .strict()
  .superRefine((image, ctx) => {
    const issue = (message) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['data'], message });
    if (image.data.length > MAX_BASE64) return;
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data) return issue('Invalid canonical base64 image');
    if (bytes.length > MAX_IMAGE_BYTES) return issue('Image exceeds 5 MiB decoded bytes');
    if (!matchesMime(bytes, image.mimeType)) issue('Image signature does not match mimeType');
  });
export const imagesSchema = z
  .array(imageSchema)
  .min(1)
  .describe(
    'Native Pi image blocks: PNG/JPEG/GIF/WebP, one or more images, at most 5 MiB decoded bytes in total. The selected model must support images.',
  )
  .superRefine((images, ctx) => {
    if (
      images.reduce((sum, image) => sum + Buffer.byteLength(image.data, 'base64'), 0) >
      MAX_IMAGE_BYTES
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Images exceed 5 MiB total decoded bytes',
      });
  });
const promptSchema = z.object({
  text: z.string().min(1).max(100000).optional(),
  images: imagesSchema.optional(),
  model: modelSelectionSchema.optional(),
});
export function promptInput(args) {
  const parsed = promptSchema.safeParse({
    text: args.text,
    images: args.images,
    model: args.model,
  });
  if (!parsed.success) throw new Error('INVALID_PROMPT_INPUT');
  const { text, images, model } = parsed.data;
  if (text === undefined && images === undefined) {
    if (model) throw new Error('MODEL_REQUIRES_PROMPT');
    return undefined;
  }
  // Pi 1.1 removes consumed queue entries only for nonempty message text.
  // Give image-only prompts a neutral label so completed steering/follow-up
  // input cannot leave a phantom pending queue that blocks idle handoff.
  return {
    text: text ?? '[Image attachment]',
    ...(images ? { images } : {}),
    ...(model ? { model } : {}),
  };
}
// Accept normalized image-only IPC input as well as a direct owner's input.
export function attachedPromptInput(args) {
  const input = promptInput({
    ...args,
    text: args.text === '' && args.images ? undefined : args.text,
  });
  if (!input) throw new Error('INVALID_ATTACHED_SEND');
  return input;
}
export function assertImageModel(images, model) {
  if (images && !model?.input?.includes('image')) throw new Error('MODEL_IMAGE_INPUT_UNSUPPORTED');
}
