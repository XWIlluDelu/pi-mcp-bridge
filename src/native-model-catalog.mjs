// Short-lived native catalog reader. No session, resource loader or extension
// factory is constructed. Native credential parsing uses the selected installation's read-only
// store; neither credentials nor cached catalogs are initialized or mutated.
import { loadPiSdk, loadPiAi } from './pi-installation.mjs';
import { catalogPage } from './models.mjs';
import { catalogStores } from './model-catalog-storage.mjs';

try {
  const { installation, ...args } = JSON.parse(process.argv[2]);
  const { ModelRuntime } = await loadPiSdk(installation);
  const { getSupportedThinkingLevels } = await loadPiAi(installation);
  const runtime = await ModelRuntime.create({
    ...(await catalogStores(installation)),
    allowModelNetwork: false,
  });
  if (runtime.getError()) throw new Error('MODEL_CATALOG_UNAVAILABLE');
  process.stdout.write(
    JSON.stringify(catalogPage(runtime.getAvailableSnapshot(), args, getSupportedThinkingLevels)),
  );
} catch {
  // Never print the underlying error, even to stderr.
  process.exitCode = 1;
}
