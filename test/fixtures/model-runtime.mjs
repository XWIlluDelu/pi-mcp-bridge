import { denyAllPermissions } from './permissions.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../../src/bridge.mjs';
import { isolatedRuntime } from './isolated-runtime.mjs';
import { savedSession, savedEntries } from './saved-session.mjs';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(fn) {
  for (let i = 0; i < 1000; i++) {
    if (await fn()) return;
    await pause(10);
  }
  throw Error('MODEL_TEST_TIMEOUT');
}
export const choice = (id) => ({ provider: 'model-fixture', id });
export { savedEntries } from './saved-session.mjs';
export async function releasedEntries(bridge, id) {
  await until(() => !bridge.pool.get(id) && !bridge.autoReleases.size);
  return savedEntries(bridge, id);
}
export async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-model-test-'),
    cwd = path.join(dir, 'project'),
    gate = path.join(dir, 'continue');
  const old = process.env.PI_MODEL_GATE;
  let bridge;
  t.after(async () => {
    try {
      await fs.writeFile(gate, 'go');
      await fs.writeFile(gate + '.exit', 'go');
      await fs.writeFile(gate + '.preflight-release', 'go');
      await bridge?.close();
    } finally {
      if (old === undefined) delete process.env.PI_MODEL_GATE;
      else process.env.PI_MODEL_GATE = old;
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, create: true, stop: true }],
  };
  // Let Pi register the fixture's native tool; the synthetic provider calls only it.
  delete config.piRuntime.tools;
  config.piArgs.push(
    '--no-extensions',
    '-e',
    path.resolve('test/fixtures/model-provider.mjs'),
    '--provider',
    'model-fixture',
    '--model',
    'alpha',
    '--thinking',
    'off',
  );
  config.piRuntime.inheritEnv = ['PI_MODEL_GATE'];
  process.env.PI_MODEL_GATE = gate;
  await fs.mkdir(config.piRuntime.agentDir);
  const settings = path.join(config.piRuntime.agentDir, 'settings.json');
  await fs.writeFile(
    settings,
    JSON.stringify({
      cacheWarming: 'off',
      compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 },
      retry: { enabled: false },
      images: { autoResize: false },
    }),
  );
  const configFile = path.join(dir, 'owner.json');
  await fs.writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  bridge = await new Bridge(config, undefined, { configFile }).init();
  const made = await savedSession(bridge),
    id = made.session_id;
  return { dir, cwd, gate, config, configFile, settings, bridge, id };
}
export async function idle(runtime) {
  await until(async () => {
    const s = await runtime.state();
    return (
      !s.isStreaming &&
      !s.isCompacting &&
      s.pendingMessageCount === 0 &&
      runtime.settlement.sequence >= runtime.requiredSettlementSequence
    );
  });
}
