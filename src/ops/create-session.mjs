import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  resolvePiInstallation,
  piLaunchEnvironment,
  loadPiSdk,
} from '../runtime/pi-installation.mjs';
import { sessionKey, syncDir, assertNativeDirectory, writeNewFile } from '../core/storage.mjs';
import { launchProfile } from '../runtime/rpc.mjs';
import { traceSessionBranch } from '../core/data.mjs';
const exec = promisify(execFile);

// Fork committed native entries, never the Bridge read representation. An
// in-memory manager forks the native branch and its current labels without opening a writer
// on the parent's file or switching the parent's live runtime.
export async function prepareSession(config, project, { name, parentSession, captureFork } = {}) {
  const { env: baseEnv } = launchProfile(config);
  const installation = await resolvePiInstallation(config, baseEnv);
  const env = await piLaunchEnvironment(installation, baseEnv, project);
  const sdk = captureFork ? await loadPiSdk(installation) : null;
  const snapshot = sdk ? await captureFork(sdk) : null;
  const { stdout } = await exec(
    process.execPath,
    [
      fileURLToPath(new URL('./native-create.mjs', import.meta.url)),
      JSON.stringify({
        sdkEntry: installation.sdkEntry,
        roots: config.sessionRoots,
        args: config.piArgs ?? [],
        parentSession,
      }),
    ],
    { cwd: project, env, timeout: 10000, maxBuffer: 65536 },
  );
  const { file, header, error } = JSON.parse(stdout);
  if (error) throw new Error(error);
  const { id, timestamp } = header;
  let entries = [];
  if (snapshot && snapshot.leafId !== null) {
    const { header, entries: raw, leafId } = snapshot;
    if (!traceSessionBranch(raw, leafId, snapshot.byId).ancestry.has(leafId))
      throw new Error('INVALID_RUNTIME_ENTRIES');
    const manager = sdk.SessionManager.inMemory(header.cwd || project, undefined, [header, ...raw]);
    manager.createBranchedSession(leafId);
    entries = manager.getEntries();
  }
  if (name !== undefined)
    entries.push({
      type: 'session_info',
      id: randomUUID(),
      parentId: entries.at(-1)?.id ?? null,
      timestamp,
      name,
    });
  return {
    session: { id: sessionKey(file, id), header, file, cwd: project },
    entries,
  };
}

export async function persistSession(session, entries) {
  const directory = path.dirname(session.file);
  await assertNativeDirectory(directory);
  const temporary = `${session.file}.${randomUUID()}.pending`;
  function* lines() {
    yield JSON.stringify(session.header) + '\n';
    for (const entry of entries) yield JSON.stringify(entry) + '\n';
  }
  await writeNewFile(temporary, lines());
  let published = false;
  try {
    // Publish a complete immutable prefix without overwriting an existing file.
    // Discovery rejects the brief two-link interval until the temp is unlinked.
    await fs.link(temporary, session.file);
    published = true;
    await fs.unlink(temporary);
    await syncDir(directory);
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
