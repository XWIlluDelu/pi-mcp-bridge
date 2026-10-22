// Short-lived native catalog reader. No session, resource loader or extension
// factory is constructed. Native credential parsing uses the pinned read-only
// store; neither credentials nor cached catalogs are initialized or mutated.
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { catalogPage } from './models.mjs';
import { catalogStores } from './model-catalog-storage.mjs';

try {
  const args = JSON.parse(process.argv[2]);
  const runtime = await ModelRuntime.create({
    ...(await catalogStores()),
    allowModelNetwork: false,
  });
  if (runtime.getError()) throw new Error('MODEL_CATALOG_UNAVAILABLE');
  process.stdout.write(JSON.stringify(catalogPage(runtime.getAvailableSnapshot(), args)));
} catch {
  // Never print the underlying error, even to stderr.
  process.exitCode = 1;
}
