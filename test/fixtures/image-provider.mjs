import { fauxProvider, fauxAssistantMessage } from './pi.mjs';
import { imageEvidence } from './image-input.mjs';
import fs from 'node:fs/promises';

export function imageReply(context) {
  const message = context.messages.findLast((message) => message.role === 'user');
  const images = Array.isArray(message?.content)
    ? message.content.filter((block) => block.type === 'image')
    : [];
  // Observe actual provider input, not an input event or a Bridge request.
  // Digest only the test image bytes: do not echo large base64 into model output.
  return fauxAssistantMessage('IMAGE_CONTEXT:' + JSON.stringify(images.map(imageEvidence)));
}
export function imageInputExtension(pi) {
  pi.on('input', (event) => {
    if (event.text.startsWith('HANDLE_IMAGE_TEST')) {
      const evidence = event.images?.map(imageEvidence);
      if (!evidence?.length || !event.text.includes(evidence[0].sha256))
        throw new Error('INPUT_IMAGE_CHANGED');
      pi.appendEntry('image-input-fixture', evidence);
      return { action: 'handled' };
    }
    if (event.text === 'TRANSFORM_IMAGE_TEST')
      return { action: 'transform', text: 'IMAGE_TRANSFORMED', images: [] };
  });
  pi.on('before_agent_start', async (event, ctx) => {
    if (event.messageType === 'user' && event.prompt === 'SELECT_IMAGE_TEST')
      await pi.setModel(ctx.modelRegistry.find(ctx.model.provider, 'vision'));
  });
}
export default function (pi) {
  imageInputExtension(pi);
  globalThis.fetch = async () => {
    throw new Error('Image fixture blocks network');
  };
  const faux = fauxProvider({
    provider: 'image-fixture',
    models: [
      { id: 'vision', input: ['text', 'image'] },
      { id: 'text-only', input: ['text'] },
      { id: 'reasoner', input: ['text', 'image'], reasoning: true },
    ],
    tokensPerSecond: 10000,
  });
  faux.setResponses(
    Array.from({ length: 24 }, () => async (context) => {
      const message = context.messages.findLast((message) => message.role === 'user');
      if (
        process.env.PI_IMAGE_TEST_GATE &&
        JSON.stringify(message?.content).includes('HOLD_IMAGE_TEST')
      ) {
        while (
          !(await fs.stat(process.env.PI_IMAGE_TEST_GATE).then(
            () => true,
            () => false,
          ))
        )
          await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return imageReply(context);
    }),
  );
  pi.registerProvider(faux.provider);
}
