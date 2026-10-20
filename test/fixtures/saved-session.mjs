import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { opaqueId } from '../../src/storage.mjs';

// Seed persisted history without starting Pi or exercising create-and-send.
// Tests of create itself must call Bridge.create with an initial prompt.
export async function savedSession(bridge, { folder_id, request_id } = {}) {
  const folder =
    bridge.config.folders.find((folder) => folder.id === folder_id) ?? bridge.config.folders[0];
  const id = randomUUID(),
    timestamp = new Date().toISOString();
  const file = path.join(
    bridge.config.sessionRoots[0],
    `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd: folder.path }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return { request_id, status: 'created', session_id: opaqueId(`${file}\0${id}`) };
}
