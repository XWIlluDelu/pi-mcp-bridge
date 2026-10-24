import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { opaqueId } from '../../src/storage.mjs';

// Seed persisted history without starting Pi or exercising create-and-send.
// Tests of public creation must call Bridge.create.
export async function savedSession(bridge, { project = bridge.config.folders[0]?.path } = {}) {
  const id = randomUUID(),
    timestamp = new Date().toISOString();
  const file = path.join(
    bridge.config.sessionRoots[0],
    `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'session', version: 3, id, timestamp, cwd: project }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  return { status: 'created', session_id: opaqueId(`${file}\0${id}`) };
}

export async function savedEntries(bridge, id) {
  const session = await bridge.session(id);
  return (await fs.readFile(session.file, 'utf8')).trim().split('\n').map(JSON.parse).slice(1);
}
