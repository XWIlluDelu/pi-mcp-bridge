// A registry writer controlled over test IPC.
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { registryTransaction, processIdentity } from '../../src/attachments.mjs';
const dir = process.argv[2],
  request = once(process, 'message');
process.send({ type: 'ready' });
await request;
const action = async () => {
  const owner = await processIdentity(),
    release = once(process, 'message');
  const marker = path.join(dir, 'critical');
  // The marker is only a test assertion, never a recovery lock.
  await fs.writeFile(marker, String(process.pid), { flag: 'wx' });
  try {
    process.send({ type: 'entered', owner });
    await release;
  } finally {
    await fs.unlink(marker);
  }
};
try {
  await registryTransaction(dir, action);
  process.send({ type: 'done' });
} catch (error) {
  process.send({ type: 'done', error: error.code ?? error.message });
}
process.disconnect();
