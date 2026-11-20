import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolvePiLaunch } from '../runtime/pi-installation.mjs';
import { diagnostics } from '../core/diagnostics.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./native-model-catalog.mjs', import.meta.url));

// A separate process gives native configuration its owner-selected environment
// without temporarily mutating Bridge process.env or sharing provider registries.
export async function loadModelCatalog(config, { offset, limit }) {
  const { installation, env } = await resolvePiLaunch(config);
  let failure;
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
    const result = JSON.parse(stdout);
    if (!result.failure) return result;
    failure = result.failure;
  } catch (error) {
    const invalid = error instanceof SyntaxError;
    failure = {
      catalog_stage: invalid ? 'response' : 'subprocess',
      catalog_reason: invalid
        ? 'invalid_response'
        : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'output_limit'
          : error.killed
            ? 'timeout'
            : 'process_failed',
    };
  }
  const { catalog_stage, catalog_reason } = failure;
  diagnostics.emit('model_catalog.failure', { catalog_stage, catalog_reason });
  throw new Error('MODEL_CATALOG_UNAVAILABLE');
}
