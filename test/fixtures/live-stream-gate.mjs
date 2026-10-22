// Hold the synthetic provider after its first visible text chunk, not a timer
// assumption about how quickly a later read/list request will execute.
import fs from 'node:fs/promises';
import path from 'node:path';
export default function liveStreamGate(pi) {
  let run = 0,
    chunks = 0;
  pi.on('provider_stream_event', async (event, ctx) => {
    if (event.data.type === 'start') {
      run++;
      chunks = 0;
    }
    if (event.data.type !== 'text_delta' || ++chunks !== 2) return;
    const gate = path.join(ctx.cwd, '..', 'finish-live-stream-' + run);
    while (
      !(await fs.stat(gate).then(
        () => true,
        () => false,
      ))
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
  });
}
