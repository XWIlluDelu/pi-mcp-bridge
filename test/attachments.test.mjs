import { until } from './fixtures/until.mjs';
import { nativeOwner, launchNativeTui, nativeTui, fauxArgs } from './fixtures/native-owner.mjs';

import { test } from 'node:test';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { Bridge } from '../src/bridge.mjs';
import { readClaim, reserveOwner, ownerAlive, registryTransaction } from '../src/attachments.mjs';
import { companionHooks } from './fixtures/companion.mjs';

const fixture = (t) =>
  nativeOwner(t, {
    prefix: 'attach',
    configure: ({ config }) => {
      config.attachmentExitTimeoutMs = 4000;
    },
  });
test('overlong attachment path prevents bridge startup and official TUI exits on registration failure', async (t) => {
  const f = await fixture(t);
  await f.bridge.close();
  f.config.attachmentDir = path.join(f.dir, 'x'.repeat(80));
  await assert.rejects(new Bridge(f.config).init(), /ATTACHMENT_SOCKET_PATH_TOO_LONG/);
  const env = { ...f.env, PI_MCP_ATTACH_DIR: f.config.attachmentDir };
  delete env.PI_MCP_OWNER_CONFIG;
  const launched = launchNativeTui(
    f,
    [
      ...f.config.piArgs,
      '--session',
      f.session.file,
      '-e',
      path.resolve('src/attach-extension.mjs'),
      ...fauxArgs,
    ],
    env,
  );
  await launched.waitFor('ATTACHMENT_SOCKET_PATH_TOO_LONG');
  await until(() => launched.child.exitCode !== null);
  assert.ok(await fs.stat(f.session.file));
  assert.equal(f.bridge.pool.instances.size, 0);
});

test('registry failure during shutdown still closes old socket and retains blocking ownership', async (t) => {
  const f = await fixture(t),
    handlers = await companionHooks(f);
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionFile: () => f.session.file,
      getHeader: () => f.session.header,
      getSessionId: () => f.session.header.id,
    },
  };
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let held;
  try {
    await handlers.session_start({ reason: 'startup' }, ctx);
    const record = await readClaim(f.config.attachmentDir, f.session);
    held = registryTransaction(f.config.attachmentDir, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await assert.rejects(
      handlers.session_shutdown({ reason: 'reload' }, ctx),
      /ATTACHMENT_REGISTRY_BUSY/,
    );
    await assert.rejects(fs.stat(record.socket), { code: 'ENOENT' });
    release.resolve();
    await held;
    assert.equal(
      (await readClaim(f.config.attachmentDir, f.session)).generation,
      record.generation,
    );
    assert.equal(await ownerAlive(record.owner), true);
    await assert.rejects(
      reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
      /LIVE_OWNER_UNREACHABLE/,
    );
  } finally {
    release.resolve();
    await held;
  }
});

test('official TUI session replacement registers a fresh identity and socket loss does not spawn RPC', async (t) => {
  const f = await fixture(t);
  const commands = path.join(f.dir, 'commands.mjs');
  await fs.writeFile(
    commands,
    `
    export default pi => pi.registerCommand('fixture-fork', { handler: async (_a, ctx) => {
      const entry = ctx.sessionManager.getEntries().find(e => e.message?.role === 'user');
      await ctx.fork(entry.id, { position: 'at' });
    } });
  `,
  );
  await nativeTui(f, f.session, ['-e', commands]);
  const initial = await readClaim(f.config.attachmentDir, f.session);
  await f.bridge.send({ session_id: f.id, text: 'public fork fixture' });
  await until(async () =>
    (await f.bridge.read({ session_id: f.id })).items.some((x) => x.type === 'assistant'),
  );
  await until(async () => !(await f.bridge.pool.get(f.id).state()).isStreaming);
  assert.equal(
    (await f.bridge.send({ session_id: f.id, text: '/fixture-fork' })).status,
    'dispatched',
  );
  const fork = await until(async () => (await f.bridge.sessions()).find((s) => s.id !== f.id));
  const forkClaim = await until(async () => {
    const r = await readClaim(f.config.attachmentDir, fork);
    return r?.phase === 'ready' ? r : null;
  });
  assert.notEqual(forkClaim.generation, initial.generation);
  // Ready publication precedes asynchronous old-claim cleanup. Await both
  // lifecycle conditions instead of assuming they are a single transaction.
  await until(async () => (await readClaim(f.config.attachmentDir, f.session)) === null);
  assert.equal(await ownerAlive(forkClaim.owner), true);
  const replacement = fork;
  const claim = forkClaim;
  const read = await f.bridge.read({ session_id: replacement.id });
  assert.match(JSON.stringify(read), /public fork fixture/);
  await fs.unlink(claim.socket);
  const result = await f.bridge.send({
    session_id: replacement.id,
    text: 'do not start a second process',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'LIVE_OWNER_UNREACHABLE');
  assert.equal(await ownerAlive(claim.owner), true);
  assert.equal(f.bridge.pool.get(replacement.id).attached, true);
  const removed = await f.bridge.delete({
    session_id: replacement.id,
  });
  assert.equal(removed.status, 'deleted', JSON.stringify(removed));
  assert.equal(await ownerAlive(claim.owner), false);
  await assert.rejects(fs.stat(replacement.file), { code: 'ENOENT' });
});
