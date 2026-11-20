import { nativeOwner } from './native-owner.mjs';
import { until } from './until.mjs';
export { until };
import fs from 'node:fs/promises';
import path from 'node:path';
import { savedEntries } from './saved-session.mjs';
export const choice = (id) => ({ provider: 'model-fixture', id });
export { savedEntries } from './saved-session.mjs';
export async function releasedEntries(bridge, id) {
  await until(() => !bridge.pool.get(id) && !bridge.lane(id));
  return savedEntries(bridge, id);
}
export async function fixture(
  t,
  { modelArgs = ['--provider', 'model-fixture', '--model', 'alpha', '--thinking', 'off'] } = {},
) {
  const f = await nativeOwner(t, {
    prefix: 'model',
    reloadConfig: true,
    async configure({ dir, config, cleanup }) {
      const gate = path.join(dir, 'continue');
      const old = process.env.PI_MODEL_GATE;
      process.env.PI_MODEL_GATE = gate;
      t.after(() => {
        if (old === undefined) delete process.env.PI_MODEL_GATE;
        else process.env.PI_MODEL_GATE = old;
      });
      config.piRuntime.inheritEnv = ['PI_MODEL_GATE'];
      cleanup.push(async () => {
        for (const suffix of ['', '.exit', '.preflight-release'])
          await fs.writeFile(gate + suffix, 'go');
      });
      config.grants[0].delete = false;
      delete config.piRuntime.tools;
      config.piArgs.push(
        '--no-extensions',
        '-e',
        path.resolve('test/fixtures/model-provider.mjs'),
        ...modelArgs,
      );
      const agent = config.piRuntime.agentDir;
      await fs.writeFile(
        path.join(agent, 'auth.json'),
        JSON.stringify({
          'model-fixture': { type: 'api_key', key: 'synthetic-only' },
        }),
      );
      await fs.writeFile(
        path.join(agent, 'settings.json'),
        JSON.stringify({
          defaultProvider: 'model-fixture',
          defaultModel: 'alpha',
          defaultThinkingLevel: 'off',
          cacheWarming: 'off',
          retry: { enabled: false },
          images: { autoResize: false },
          compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 1024 },
        }),
      );
    },
  });
  return {
    ...f,
    gate: path.join(f.dir, 'continue'),
    settings: path.join(f.config.piRuntime.agentDir, 'settings.json'),
  };
}
export async function idle(runtime) {
  await until(async () => {
    const s = await runtime.state();
    return (
      !s.isStreaming &&
      !s.isCompacting &&
      s.pendingMessageCount === 0 &&
      runtime.settlementSequence >= runtime.requiredSettlementSequence
    );
  });
}
