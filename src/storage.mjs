// Filesystem primitives shared by receipts, configuration and session storage.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const opaqueId = value => `ps_${hash(value).slice(0, 32)}`;
export async function atomicJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const h = await fs.open(tmp, 'w', 0o600);
  try { await h.writeFile(JSON.stringify(value, null, 2)); await h.sync(); } finally { await h.close(); }
  await fs.rename(tmp, file);
  await syncDir(path.dirname(file));
}
export async function syncDir(dir) {
  const handle = await fs.open(dir,'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
