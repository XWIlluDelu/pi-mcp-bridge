import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { processIdentity } from '../../src/runtime/attachments.mjs';
import { RpcClient } from './pi.mjs';
import { nativePiCli } from './isolated-runtime.mjs';

export async function nativeRpc(fixture, options) {
  const client = new RpcClient({
    cliPath: nativePiCli,
    cwd: fixture.cwd,
    env: fixture.env,
    ...options,
  });
  fixture.cleanup.push(() => client.stop());
  await client.start();
  return client;
}

// Start without a saved writer, reserve the target for the actual Pi PID, and
// then let the test publish its chosen binding.
export async function nativeRpcHost(fixture, { args, ...options }) {
  const pidFile = path.join(fixture.dir, 'rpc-host-pid');
  const extension = path.join(fixture.dir, 'rpc-host-identity.mjs');
  await fs.writeFile(
    extension,
    `import fs from 'node:fs';export default () => fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
  );
  const client = await nativeRpc(fixture, {
    ...options,
    args: ['--no-session', '-e', extension, ...args],
  });
  await client.getState();
  const owner = await processIdentity(Number(await fs.readFile(pidFile, 'utf8')));
  assert.ok(owner && owner.pid !== process.pid);
  const controller = await fixture.reserveHost(fixture.session, owner);
  const { cancelled } = await client.switchSession(fixture.session.file);
  assert.equal(cancelled, false);
  return { client, controller, owner };
}
