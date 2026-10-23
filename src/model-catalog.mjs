import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchProfile } from './rpc.mjs';
import { resolvePiInstallation } from './pi-installation.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./native-model-catalog.mjs', import.meta.url));

// A separate process gives native configuration its owner-selected environment
// without temporarily mutating Bridge process.env or sharing provider registries.
export async function loadModelCatalog(config, { offset, limit }) {
  const { env } = launchProfile(config);
  const installation = await resolvePiInstallation(config, env);
  try {
    const { stdout } = await execute(
      process.execPath,
      [helper, JSON.stringify({ offset, limit, installation })],
      {
        env,
        timeout: 15000,
        maxBuffer: 512 * 1024,
      },
    );
    return JSON.parse(stdout);
  } catch {
    // Neither native errors nor subprocess stdout/stderr may disclose credentials.
    throw new Error('MODEL_CATALOG_UNAVAILABLE');
  }
}
