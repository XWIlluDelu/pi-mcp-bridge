import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeOwner } from './fixtures/native-owner.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { RpcClient } from './fixtures/pi.mjs';
import { readClaim } from '../src/attachments.mjs';

test('native profile discovery leaves an owned RPC claim intact and registers an ordinary RPC', async (t) => {
  const companion = new URL('../src/attach-extension.mjs', import.meta.url).pathname;
  const f = await nativeOwner(t, {
    prefix: 'startup',
    async configure({ config }) {
      const extensions = path.join(config.piRuntime.agentDir, 'extensions');
      await fs.mkdir(extensions);
      await fs.writeFile(
        path.join(config.piRuntime.agentDir, 'settings.json'),
        JSON.stringify({
          cacheWarming: 'off',
          extensions: [companion],
        }),
      );
      await fs.writeFile(
        path.join(extensions, 'probe.js'),
        "export default pi => pi.on('session_start', () => pi.appendEntry('profile-probe', { tools: pi.getActiveTools() }));",
      );
      delete config.piRuntime.tools;
    },
  });
  const claim = () => readClaim(f.config.attachmentDir, f.session);
  const rpc = await f.bridge.pool.resolve(f.session);
  assert.equal((await claim()).generation, rpc.ownerRecord.generation);
  assert.equal((await claim()).kind, 'rpc');
  const probe = (await rpc.entries()).entries.find((row) => row.customType === 'profile-probe');
  for (const tool of ['read', 'bash', 'edit', 'write']) assert.ok(probe.data.tools.includes(tool));
  await rpc.gracefulExit();

  const local = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.cwd,
    env: f.env,
    args: ['--offline', '--session', f.session.file, '-e', companion],
  });
  f.cleanup.push(() => local.stop());
  await local.start();
  assert.equal((await local.getState()).sessionId, f.session.header.id);
  const external = await claim();
  assert.equal(external.kind, 'extension');
  assert.equal(external.phase, 'ready');
  assert.equal((await f.bridge.read({ session_id: f.id })).source, 'extension');
});
