// Short-lived native catalog reader. No sessions, extensions, credential writes
// or network refresh. Stderr carries only our content-free failure category.
import { loadPiSdk, loadPiAi } from './pi-installation.mjs';
import { catalogPage } from './models.mjs';
import { catalogStores } from './model-catalog-storage.mjs';

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
