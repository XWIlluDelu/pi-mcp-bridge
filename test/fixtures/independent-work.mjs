// A real extension starts native work outside the Bridge's session lane.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fauxProvider, fauxAssistantMessage } from './pi.mjs';
export default function independentWork(pi) {
  const dir = path.dirname(process.cwd());
  const mark = (name) => fs.writeFile(path.join(dir, name), 'yes');
  const wait = async (name) => {
    while (
      !(await fs.stat(path.join(dir, name)).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const faux = fauxProvider({
    provider: 'idle-guard-fixture',
    models: [{ id: 'guarded' }],
    tokensPerSecond: 10000,
  });
  faux.setResponses([
    fauxAssistantMessage('FIRST_DONE'),
    async () => {
      await mark('second-provider');
      await wait('finish');
      return fauxAssistantMessage('SECOND_DONE');
    },
  ]);
  pi.registerProvider(faux.provider);
  pi.on('input', async (event) => {
    if (event.text === 'SECOND_REAL_RUN') {
      await mark('second-input');
      await wait('input-go');
    }
    return { action: 'continue' };
  });
  pi.on('session_start', async () => {
    await pi.setModel(faux.getModel());
    void wait('new-run').then(() => pi.sendUserMessage('SECOND_REAL_RUN'));
  });
}
