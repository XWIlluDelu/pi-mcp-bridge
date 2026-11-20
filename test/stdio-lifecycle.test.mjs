import { nativeOwner, nativeTui, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import { test } from 'node:test';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';

import { launchStdio } from './fixtures/stdio-client.mjs';
import { readClaim, ownerAlive } from '../src/runtime/attachments.mjs';
const exists = (file) =>
  fs.stat(file).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
async function fixture(t) {
  const f = await nativeOwner(t, {
    prefix: 'stdio-life',
    async configure(context) {
      context.config.piArgs = ['--offline'];
      await gatedExtension(
        context,
        `
        pi.registerCommand('lifecycle-fixture', { handler: async () => {
          await mark('dispatch');
          await new Promise(r => setTimeout(r, 300));
        } });
      `,
      );
    },
  });
  await f.bridge.close();
  return { ...f, marker: path.join(f.dir, 'dispatch') };
}
async function stopped(f, owner) {
  if (owner) assert.equal(await ownerAlive(owner), false);
  assert.equal(await readClaim(f.config.attachmentDir, f.session), null);
}
async function ownClaim(f) {
  return until(async () => {
    const r = await readClaim(f.config.attachmentDir, f.session);
    return r?.phase === 'ready' ? r : null;
  });
}

for (const stage of ['before-acquire', 'after-acquire', 'owner-listen-failure'])
  test(
    `stop during initialization waits for ${stage} and releases only its acquired lock`,
    { timeout: 15000 },
    async (t) => {
      const f = await fixture(t),
        preload = path.join(f.dir, 'pause-init.mjs'),
        reached = path.join(f.dir, 'init-reached'),
        release = path.join(f.dir, 'init-release');
      await fs.writeFile(
        preload,
        `import {holdInit} from ${JSON.stringify(new URL('./fixtures/init-gate.mjs', import.meta.url).href)};holdInit(${JSON.stringify({ config: f.config, stage, reached, release })});`,
      );
      const server = launchStdio(f, ['--import', preload]);
      await until(() => exists(reached));
      server.child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 80));
      server.child.kill('SIGINT');
      assert.equal(server.child.exitCode, null);
      assert.equal(
        server.child.signalCode,
        null,
        'Signal handlers must be active before init acquires resources',
      );
      await fs.writeFile(release, 'continue');
      assert.equal(await server.exit(), stage === 'owner-listen-failure' ? 1 : 0);
      await stopped(f);
      const restarted = launchStdio(f);
      assert.ok((await restarted.request('ping')).result);
      restarted.child.stdin.end();
      assert.equal(await restarted.exit(), 0);
      await stopped(f);
    },
  );

for (const outputBroken of [false, true])
  test(
    `stdio drains native input before ${outputBroken ? 'closing broken stdout' : 'finishing EOF'}`,
    {
      timeout: 15000,
    },
    async (t) => {
      const f = await fixture(t),
        server = launchStdio(f);
      const pending = server.call('send', { session_id: f.id, text: '/lifecycle-fixture' });
      await until(() => exists(f.marker));
      const { owner } = await ownClaim(f);
      if (outputBroken) {
        server.child.stdout.destroy();
        server.request('tools/list', {});
      } else {
        server.child.stdin.end();
        assert.equal((await pending).structuredContent.status, 'handled');
      }
      assert.equal(await server.exit(), Number(outputBroken));
      await stopped(f, owner);
      assert.doesNotMatch(server.stderr(), /Unhandled/);
      const restarted = launchStdio(f);
      const result = await restarted.call('list', { session_id: f.id });
      assert.equal(result.structuredContent.sessions[0].session_id, f.id);
      restarted.child.stdin.end();
      assert.equal(await restarted.exit(), 0);
    },
  );

test('stdio EOF disconnects a native TUI without stopping its writer', async (t) => {
  const f = await fixture(t);
  const tui = await nativeTui(f, f.session);
  const claim = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(claim.kind, 'tui');
  const server = launchStdio(f);
  assert.equal(
    (await server.call('read', { session_id: f.id })).structuredContent.session_id,
    f.id,
  );
  server.child.stdin.end();
  assert.equal(await server.exit(), 0);
  assert.equal(await ownerAlive(tui.owner), true);
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, claim.generation);
});
