import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { opaqueId, syncDir } from './storage.mjs';

// Fork committed native entries, never the Bridge read representation. An
// in-memory manager selects the native ancestor branch without opening a writer
// on the parent's file or switching the parent's live runtime.
export function prepareSession(config, project, { name, parent, snapshot } = {}) {
  const id = randomUUID(),
    timestamp = new Date().toISOString();
  const file = path.join(config.sessionRoots[0], `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const header = {
    type: 'session',
    version: 3,
    id,
    timestamp,
    cwd: project,
    ...(parent ? { parentSession: parent.file } : {}),
  };
  let entries = [];
  if (parent) {
    if (
      !Array.isArray(snapshot?.entries) ||
      (snapshot.leafId !== null && !snapshot.entries.some((entry) => entry.id === snapshot.leafId))
    )
      throw new Error('INVALID_RUNTIME_ENTRIES');
    const manager = SessionManager.inMemory(parent.header.cwd, undefined, [
      parent.header,
      ...snapshot.entries,
    ]);
    entries = snapshot.leafId === null ? [] : manager.getBranch(snapshot.leafId);
  }
  if (name !== undefined)
    entries.push({
      type: 'session_info',
      id: randomUUID(),
      parentId: entries.at(-1)?.id ?? null,
      timestamp,
      name,
    });
  return { id: opaqueId(`${file}\0${id}`), header, file, cwd: project, entries };
}

export async function persistSession(session) {
  const temporary = `${session.file}.${randomUUID()}.pending`;
  let published = false;
  try {
    const fd = await fs.open(temporary, 'wx', 0o600);
    try {
      await fd.writeFile(JSON.stringify(session.header) + '\n');
      for (const entry of session.entries) await fd.writeFile(JSON.stringify(entry) + '\n');
      await fd.sync();
    } finally {
      await fd.close();
    }
    // Publish a complete immutable prefix without overwriting an existing file.
    // Discovery rejects the brief two-link interval until the temp is unlinked.
    await fs.link(temporary, session.file);
    published = true;
    await fs.unlink(temporary);
    await syncDir(path.dirname(session.file));
  } catch (error) {
    if (published) {
      error.sessionPublished = true;
      error.uncertain = true;
    }
    throw error;
  } finally {
    await fs.unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
