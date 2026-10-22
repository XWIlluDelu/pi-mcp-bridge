import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPiSdk } from './pi-installation.mjs';

// Native store interfaces, without creating files, refreshing credentials or
// duplicating Pi's model schema. Native ModelRuntime interprets cached data.
export async function catalogStores(installation) {
  const { getAgentDir } = await loadPiSdk(installation);
  // Pi exports this read-only CredentialStore from its module, not its SDK root.
  // Missing native APIs fail the catalog; no bundled or version fallback.
  const { ReadOnlyAuthStorage } = await import(
    new URL('./core/auth-storage.js', pathToFileURL(installation.sdkEntry)).href
  );
  let contents;
  try {
    contents = await fs.readFile(path.join(getAgentDir(), 'models-store.json'), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const snapshot = contents ? JSON.parse(contents.replace(/^\uFEFF/, '')) : {};
  const rejectWrite = async () => {
    throw new Error('MODEL_CATALOG_READ_ONLY');
  };
  return {
    credentials: new ReadOnlyAuthStorage(),
    modelsStore: {
      async read(provider, options) {
        options?.signal?.throwIfAborted();
        return Object.hasOwn(snapshot, provider) ? structuredClone(snapshot[provider]) : undefined;
      },
      write: rejectWrite,
      delete: rejectWrite,
    },
  };
}
