import { fauxProvider, fauxAssistantMessage, fauxToolCall } from './pi.mjs';
import fs from 'node:fs/promises';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
export default function (pi) {
  globalThis.fetch = async () => {
    throw new Error('Model fixture blocks network');
  };
  const faux = fauxProvider({
    provider: 'model-fixture',
    models: [
      {
        id: 'alpha',
        name: 'Alpha text',
        input: ['text'],
        reasoning: false,
        contextWindow: 16000,
        maxTokens: 2048,
      },
      {
        id: 'vision',
        name: 'Vision',
        input: ['text', 'image'],
        reasoning: true,
        contextWindow: 32000,
        maxTokens: 4096,
      },
      {
        id: 'reasoner',
        name: 'Reasoner',
        input: ['text'],
        reasoning: true,
        contextWindow: 32000,
        maxTokens: 4096,
      },
    ],
    tokensPerSecond: 10000,
  });
  pi.registerTool({
    name: 'model_fixture_tool',
    label: 'Model boundary fixture',
    description: 'Gated native tool for model boundary tests',
    parameters: { type: 'object', properties: {} },
    async execute() {
      await fs.writeFile(process.env.PI_MODEL_GATE + '.tool-start', 'started');
      while (!(await exists(process.env.PI_MODEL_GATE))) await pause(10);
      return { content: [{ type: 'text', text: 'tool complete' }], details: {} };
    },
  });
  pi.on('input', async (event) => {
    if (event.text !== 'HOLD_PREFLIGHT') return;
    const gate = process.env.PI_MODEL_GATE;
    await fs.writeFile(gate + '.preflight-start', 'started');
    while (!(await exists(gate + '.preflight-release'))) await pause(10);
    return { action: 'handled' };
  });
  pi.on('session_start', () => {
    pi.setActiveTools(['model_fixture_tool']);
  });
  pi.registerCommand('fixture-independent-input', {
    description: 'Start fixture input outside Bridge admission',
    handler: async (text) => {
      pi.sendUserMessage(text);
    },
  });
  pi.on('session_shutdown', async () => {
    const gate = process.env.PI_MODEL_GATE;
    if (await exists(gate + '.hold-shutdown')) {
      await fs.writeFile(gate + '.shutdown-start', 'started');
      while (!(await exists(gate + '.exit'))) await pause(10);
    }
  });
  pi.on('model_select', async (event) => {
    if (event.source !== 'set') return;
    const gate = process.env.PI_MODEL_GATE;
    if (await exists(gate + '.hold-selection')) while (!(await exists(gate))) await pause(10);
  });
  pi.on('session_before_compact', async (event) => {
    if (event.customInstructions === 'NATIVE_COMPACT') return;
    if (event.customInstructions === 'CANCEL_COMPACT') return { cancel: true };
    if (event.customInstructions === 'HOLD_COMPACT') {
      await fs.writeFile(process.env.PI_MODEL_GATE + '.compact-start', 'started');
      while (!event.signal.aborted && !(await exists(process.env.PI_MODEL_GATE))) await pause(10);
      if (event.signal.aborted) return { cancel: true };
    }
    return {
      compaction: {
        summary: 'Native fixture summary ' + (event.customInstructions ?? ''),
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
      },
    };
  });
  faux.setResponses(
    Array.from({ length: 100 }, () => async (context, options, _state, model) => {
      const content = context.messages.findLast((m) => m.role === 'user')?.content;
      if (process.env.PI_MODEL_GATE && JSON.stringify(content).includes('HOLD_MODEL')) {
        await fs.writeFile(process.env.PI_MODEL_GATE + '.provider-start', 'started');
        while (!options?.signal?.aborted && !(await exists(process.env.PI_MODEL_GATE)))
          await pause(10);
        if (options?.signal?.aborted)
          await fs.writeFile(process.env.PI_MODEL_GATE + '.provider-aborted', 'aborted');
      }
      if (context.messages.at(-1)?.role === 'user' && JSON.stringify(content).includes('USE_TOOL'))
        return fauxAssistantMessage([fauxToolCall('model_fixture_tool', {})], {
          stopReason: 'toolUse',
        });
      return fauxAssistantMessage(
        'MODEL_INPUT:' +
          JSON.stringify({
            provider: model.provider,
            id: model.id,
            content,
            reasoning: options?.reasoning ?? null,
          }),
      );
    }),
  );
  pi.registerProvider(faux.provider);
}
