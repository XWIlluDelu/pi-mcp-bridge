import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { launchProfile } from './rpc.mjs';
import { resolvePiInstallation } from './pi-installation.mjs';
import { diagnostics } from './diagnostics.mjs';

const execute = promisify(execFile);
const helper = fileURLToPath(new URL('./native-model-catalog.mjs', import.meta.url));

// A separate process gives native configuration its owner-selected environment
// without temporarily mutating Bridge process.env or sharing provider registries.
export async function loadModelCatalog(config, { offset, limit }) {
  const { env } = launchProfile(config);
  const installation = await resolvePiInstallation(config, env);
  let stage = 'subprocess';
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
    stage = 'response';
    return JSON.parse(stdout);
  } catch (error) {
    let failure;
    if (stage === 'subprocess') {
      try {
        failure = JSON.parse(error.stderr);
      } catch {}
    }
    // The diagnostic sink accepts only known stage/reason values, never raw
    // subprocess text. Remote callers keep a content-free public error.
    diagnostics.emit('model_catalog.failure', {
      catalog_stage: failure?.stage ?? stage,
      catalog_reason:
        failure?.reason ??
        (stage === 'response'
          ? 'invalid_response'
          : error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'output_limit'
            : error.killed
              ? 'timeout'
              : 'process_failed'),
    });
    throw new Error('MODEL_CATALOG_UNAVAILABLE');
  }
}
