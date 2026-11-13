// Short-lived native catalog reader. No sessions, extensions, credential writes
// or network refresh. Stderr carries only our content-free failure category.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPiSdk, loadPiAi } from './pi-installation.mjs';
import { catalogPage } from './models.mjs';

// Native store interfaces, without creating files, refreshing credentials or
// duplicating Pi's model schema. Native ModelRuntime interprets cached data.
async function catalogStores(installation) {
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

let stage = 'modules';
try {
  const { installation, ...args } = JSON.parse(process.argv[2]);
  const { ModelRuntime } = await loadPiSdk(installation);
  const { getSupportedThinkingLevels } = await loadPiAi(installation);
  stage = 'storage';
  const stores = await catalogStores(installation);
  stage = 'runtime';
  const runtime = await ModelRuntime.create({
    ...stores,
    allowModelNetwork: false,
  });
  if (runtime.getError()) {
    stage = 'configuration';
    throw new Error('MODEL_CATALOG_UNAVAILABLE');
  }
  stage = 'projection';
  process.stdout.write(
    JSON.stringify(catalogPage(runtime.getAvailableSnapshot(), args, getSupportedThinkingLevels)),
  );
} catch (error) {
  const reason =
    stage === 'configuration'
      ? 'invalid_configuration'
      : error instanceof SyntaxError
        ? 'invalid_json'
        : ['EACCES', 'EPERM'].includes(error?.code)
          ? 'permission_denied'
          : error?.code === 'ENOENT'
            ? 'not_found'
            : 'native_failure';
  process.stderr.write(JSON.stringify({ stage, reason }) + '\n');
  process.exitCode = 1;
}
