import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSingleSessionFile, readSessionIdentity, syncDir } from './data.mjs';

async function privateTrashDirectory(dir, io) {
  await io.mkdir(dir, {recursive:true, mode:0o700});
  const stat = await io.lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077) || await io.realpath(dir) !== path.resolve(dir)) throw new Error('INVALID_TRASH_DIRECTORY');
  return stat;
}

// Prepare all recovery records before stopping a runtime. The adjacent record is
// authoritative; the state directory contains an index, not the moved session.
// Records describe an intent: recovery must inspect both paths after a crash.
export async function prepareTrash(config, session, {io=fs, sync=syncDir}={}) {
  const source = await assertSingleSessionFile(session.file);
  const parent = path.dirname(session.file);
  const local = path.join(parent, '.pi-mcp-trash');
  const index = path.join(config.stateDir, 'trash');
  const token = randomUUID();
  const trashPath = path.join(local, `${token}.jsonl`);
  const metadataPath = path.join(local, `${token}.restore.json`);
  const indexPath = path.join(index, `${token}.restore.json`);
  const created = [];
  let moved = false, cancelled = false;
  const cancel = async () => {
    if (moved) return;
    cancelled = true;
    for (const file of created) await io.unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
    for (const dir of new Set(created.map(file=>path.dirname(file)))) await sync(dir);
  };
  try {
    const target = await privateTrashDirectory(local, io);
    if (target.dev !== source.dev) throw new Error('TRASH_FILESYSTEM_MISMATCH');
    await privateTrashDirectory(index, io);
    await sync(parent); await sync(config.stateDir);
    const record = JSON.stringify({version:1, phase:'prepared', original_path:session.file, session_id:session.id, native_session_id:session.header.id, trash_path:trashPath, metadata_path:metadataPath});
    for (const file of [metadataPath, indexPath]) {
      const handle = await io.open(file, 'wx', 0o600);
      created.push(file);
      try { await handle.writeFile(record); await handle.sync(); } finally { await handle.close(); }
      await sync(path.dirname(file));
    }
  } catch (error) {
    await cancel().catch(()=>{});
    throw error;
  }
  return {
    token,
    get moved() { return moved; },
    cancel,
    async move() {
      if (cancelled) throw new Error('TRASH_CANCELLED');
      if (moved) throw new Error('TRASH_ALREADY_MOVED');
      const current = await assertSingleSessionFile(session.file);
      const identity = await readSessionIdentity(session.file);
      if (current.dev !== source.dev || current.ino !== source.ino || identity.header.id !== session.header.id || identity.header.cwd !== session.header.cwd) throw new Error('RUNTIME_SESSION_CHANGED');
      // Revalidate the private directory immediately before the irreversible step.
      const target = await privateTrashDirectory(local, io);
      if (target.dev !== current.dev) throw new Error('TRASH_FILESYSTEM_MISMATCH');
      await io.rename(session.file, trashPath);
      moved = true; // A later durability failure must retain recovery records.
      await sync(local); await sync(parent);
    },
  };
}
