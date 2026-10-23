import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SessionManager, CURRENT_SESSION_VERSION } from '@earendil-works/pi-coding-agent';
import { opaqueId, syncDir, assertNativeDirectory } from './storage.mjs';
import { launchProfile } from './rpc.mjs';
import { sessionEntryIndex } from './data.mjs';
const exec = promisify(execFile);

// Fork committed native entries, never the Bridge read representation. An
// in-memory manager forks the native branch and its current labels without opening a writer
// on the parent's file or switching the parent's live runtime.
export async function prepareSession(config, project, { name, parent, snapshot } = {}) {
  const { stdout } = await exec(
    process.execPath,
    [
      fileURLToPath(new URL('./native-create.mjs', import.meta.url)),
      JSON.stringify({
        roots: config.sessionRoots,
        args: config.piArgs ?? [],
        parentSession: parent?.file,
      }),
    ],
    { cwd: project, env: launchProfile(config).env, timeout: 10000, maxBuffer: 65536 },
  );
  const { file, header, error } = JSON.parse(stdout);
  if (error) throw new Error(error);
  const { id, timestamp } = header;
  let entries = [];
  if (parent) {
    if (!Array.isArray(snapshot?.entries)) throw new Error('INVALID_RUNTIME_ENTRIES');
    // Saved snapshots already carry their normalized header. Live entries use
    // Pi's current version, even when the discovery header predates writer open.
    const sourceHeader = snapshot.header ?? { ...parent.header, version: CURRENT_SESSION_VERSION };
    const manager = SessionManager.inMemory(sourceHeader.cwd || project, undefined, [
      sourceHeader,
      ...snapshot.entries,
    ]);
    if (
      snapshot.leafId !== null &&
      !manager.getEntries().some((entry) => entry.id === snapshot.leafId)
    )
      throw new Error('INVALID_RUNTIME_ENTRIES');
    if (snapshot.leafId !== null) {
      sessionEntryIndex(manager.getEntries(), snapshot.leafId);
      manager.createBranchedSession(snapshot.leafId);
      entries = manager.getEntries();
    }
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
  await assertNativeDirectory(path.dirname(session.file));
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
    // Cleanup is best effort after a failed write/publication. A second unlink
    // failure must not replace the original error or erase the published state.
    await fs.unlink(temporary).catch(() => {});
    if (published) {
      error.sessionPublished = true;
      error.uncertain = true;
    }
    throw error;
  }
}
