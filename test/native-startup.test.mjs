import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { nativeRpc } from './fixtures/native-rpc.mjs';
import { ownerAlive, readClaim } from '../src/runtime/attachments.mjs';
import { PiRpc } from '../src/runtime/rpc.mjs';

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
        `export default pi => {
          pi.registerFlag('probe-label', { type: 'string' });
          pi.on('session_start', (_event, ctx) => pi.appendEntry('profile-probe', {
            tools: pi.getActiveTools(), label: pi.getFlag('probe-label'), system: ctx.getSystemPrompt(),
          }));
        };`,
      );
      config.piArgs.push('--system-prompt', '--continue', '--probe-label=--resume');
      delete config.piRuntime.tools;
    },
  });
  const claim = () => readClaim(f.config.attachmentDir, f.session);
  const rpc = await f.bridge.pool.resolve(f.session);
  assert.equal((await claim()).generation, rpc.ownerRecord.generation);
  assert.equal((await claim()).kind, 'rpc');
  const probe = (await rpc.entries()).entries.find((row) => row.customType === 'profile-probe');
  for (const tool of ['read', 'bash', 'edit', 'write']) assert.ok(probe.data.tools.includes(tool));
  assert.match(probe.data.system, /--continue/);
  assert.equal(probe.data.label, '--resume');
  await rpc.gracefulExit();

  const local = await nativeRpc(f, {
    args: ['--offline', '--session', f.session.file, '-e', companion, ...fauxArgs],
  });
  assert.equal((await local.getState()).sessionId, f.session.header.id);
  const external = await claim();
  assert.equal(external.kind, 'extension');
  assert.equal(external.phase, 'ready');
  const args = { session_id: f.id };
  assert.equal((await f.bridge.stop(args)).reason, 'STOP_UNSUPPORTED');
  const sent = await f.bridge.send({ ...args, text: 'companion dispatch proof' });
  assert.equal(sent.status, 'dispatched');
  assert.equal(sent.admission, 'unobservable');
  await until(async () => !(await local.getState()).isStreaming);
  const read = await f.bridge.read(args);
  assert.equal(read.source, 'extension');
  assert.match(JSON.stringify(read), /companion dispatch proof/);
  assert.equal((await claim()).generation, external.generation);
  await f.bridge.close();
  assert.equal(await ownerAlive(external.owner), true);
});

test('a direct spawn failure clears its reservation without binding the Bridge process', async (t) => {
  const f = await nativeOwner(t, { prefix: 'spawn-failure' });
  const rpc = new PiRpc(f.config, f.session);
  const stat = fs.stat;
  t.mock.method(fs, 'stat', async (file, options) => {
    const info = await stat(file, options);
    // Lose the working directory after the final preflight, before spawn.
    if (file === f.cwd) await fs.rmdir(file);
    return info;
  });
  await assert.rejects(rpc.start(), { code: 'RUNTIME_START_FAILED' });
  assert.equal(rpc.childIdentity, undefined);
  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
});
