// Short-lived native catalog reader. No sessions, extensions, credential writes
// or network refresh. Only the failure stage and category leave the helper.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPiSdk, loadPiAi } from '../runtime/pi-installation.mjs';
import { ifMissing } from '../core/storage.mjs';
import { catalogPage } from './models.mjs';

// Native store interfaces, without creating files, refreshing credentials or
// duplicating Pi's model schema. Native ModelRuntime interprets cached data.
async function catalogStores(installation, directory) {
  // Pi exports this read-only CredentialStore from its module, not its SDK root.
  // Missing native APIs fail the catalog; no bundled or version fallback.
  const { ReadOnlyAuthStorage } = await import(
    new URL('./core/auth-storage.js', pathToFileURL(installation.sdkEntry)).href
  );
  const contents = await fs
    .readFile(path.join(directory, 'models-store.json'), 'utf8')
    .catch(ifMissing);
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
  const { ModelRuntime, getAgentDir } = await loadPiSdk(installation);
  const { getSupportedThinkingLevels } = await loadPiAi(installation);
  stage = 'storage';
  const stores = await catalogStores(installation, getAgentDir());
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
  process.stdout.write(
    JSON.stringify({ failure: { catalog_stage: stage, catalog_reason: reason } }),
  );
}
