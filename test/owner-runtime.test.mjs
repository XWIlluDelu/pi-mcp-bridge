import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { append, message } from './fixtures/native-history.mjs';
import { until } from './fixtures/until.mjs';

import { savedSession } from './fixtures/saved-session.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeRpc } from './fixtures/native-rpc.mjs';
import { Bridge } from '../src/core/bridge.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { readClaim, ownerAlive, waitOwnerExit } from '../src/runtime/attachments.mjs';
import { RpcFailure } from '../src/runtime/rpc.mjs';
const exec = promisify(execFile),
  base = path.resolve('.');
async function fixture(t, extraArgs = []) {
  const f = await nativeOwner(t, {
    prefix: 'owner-control',
    configure({ config }) {
      config.piArgs.push(...fauxArgs, ...extraArgs);
    },
  });
  let bridge = f.bridge;
  f.cleanup.push(() => bridge.close());
  return {
    ...f,
    get bridge() {
      return bridge;
    },
    async restart() {
      await bridge.close();
      bridge = await new Bridge(f.config).init();
    },
  };
}

test(
  'owner CLI release holds across restart and attachment; only explicit confirmed reset restores cold resume',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      args = { session_id: f.id };
    const send = (text) => f.bridge.send({ ...args, text });
    const cli = async (...args) =>
      JSON.parse(
        (
          await exec(process.execPath, [
            path.join(base, 'src/owner-runtime.mjs'),
            f.configFile,
            ...args,
          ])
        ).stdout,
      );
    await send('PRESERVE_ON_RELEASE');
    const rpc = f.bridge.pool.get(f.id),
      owner = rpc.ownerRecord.owner;
    await until(() => rpc.settlementSequence === 1);
    assert.equal((await cli('release', f.id)).status, 'released');
    assert.equal(await ownerAlive(owner), false);
    const claim = () => readClaim(f.config.attachmentDir, f.session);
    assert.equal((await claim()).phase, 'released');
    await f.restart();
    assert.equal((await send('NEVER_ADMITTED')).reason, 'COLD_REACQUIRE_BLOCKED');
    assert.match(JSON.stringify(await f.bridge.read(args)), /PRESERVE_ON_RELEASE/);

    const local = await nativeRpc(f, {
      args: [
        ...f.config.piArgs,
        '--session',
        f.session.file,
        '-e',
        path.resolve('src/attach-extension.mjs'),
      ],
    });
    await local.getState();
    const external = await claim();
    assert.equal(external.kind, 'extension');
    assert.equal(external.noColdReacquire, true);
    await assert.rejects(
      ownerRequest(f.config, { ...args, op: 'release', interrupt: true }),
      /EXTERNAL_OWNER_NOT_RELEASABLE/,
    );
    await assert.rejects(
      ownerRequest(f.config, { ...args, op: 'reset', confirm_local_closed: true }),
      /OWNER_STILL_ALIVE/,
    );
    await local.stop();
    await waitOwnerExit(external.owner);
    assert.equal((await send('NEVER_ADMITTED')).reason, 'COLD_REACQUIRE_BLOCKED');
    await assert.rejects(
      ownerRequest(f.config, { ...args, op: 'reset' }),
      /LOCAL_CLOSE_CONFIRMATION_REQUIRED/,
    );
    assert.equal((await cli('reset', f.id, '--confirm-local-closed')).status, 'reset');
    assert.equal((await send('COLD_RESUME_AFTER_RESET')).status, 'started');
  },
);

test('failed normal exit retains the owner claim without reporting release success', async (t) => {
  const f = await fixture(t),
    owned = await f.bridge.pool.resolve(f.session),
    exit = owned.gracefulExit;
  owned.gracefulExit = async () => {
    throw new RpcFailure('RUNTIME_EXIT_ABNORMAL');
  };
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RUNTIME_EXIT_ABNORMAL/,
  );
  const held = await readClaim(f.bridge.pool.attachmentDir, f.session);
  assert.equal(held.noColdReacquire, true);
  assert.equal(await ownerAlive(held.owner), true);
  owned.gracefulExit = exit;
  assert.equal(
    (await ownerRequest(f.config, { op: 'release', session_id: f.id })).status,
    'released',
  );
});

test('release of saved session and reset serialize with sends; pending startup is not aborted', async (t) => {
  const f = await fixture(t);
  f.bridge.pool.starting.set(f.id, { promise: new Promise(() => {}) });
  await assert.rejects(
    ownerRequest(f.config, { op: 'release', session_id: f.id }),
    /RUNTIME_IDLE_UNCONFIRMED/,
  );
  f.bridge.pool.starting.delete(f.id);
  const release = ownerRequest(f.config, { op: 'release', session_id: f.id });
  await release;
  const sends = await Promise.all(
    Array.from({ length: 3 }, (_, i) =>
      f.bridge.send({ session_id: f.id, text: 'NEVER_ADMITTED' }),
    ),
  );
  assert.ok(sends.every((s) => s.reason === 'COLD_REACQUIRE_BLOCKED'));
  assert.equal(f.bridge.pool.instances.size, 0);
});

test(
  'owned RPC vetoes cross-file resume/new/fork before open while keeping its claim and read-only route',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t, [
      '-e',
      path.join(base, 'test/fixtures/native-session-boundary.mjs'),
    ]);
    const marker = path.join(f.dir, 'boundary');
    const other = await savedSession(f.bridge),
      b = await f.bridge.session(other.session_id);
    const bytes = await fs.readFile(b.file);
    await append(f.session, [message('fork-source', null, 'user', 'BOUNDARY_SOURCE')]);
    const runtime = await f.bridge.pool.resolve(f.session),
      generation = runtime.ownerRecord.generation;
    // A manually retained writer makes the native lifecycle itself observable.
    for (const [command, suffix] of [
      ['/boundary-switch ' + b.file, '.switch'],
      ['/boundary-new', '.new'],
      ['/boundary-fork', '.fork'],
    ]) {
      assert.equal(
        (await runtime.command({ type: 'prompt', message: command })).disposition,
        'handled',
      );
      await until(() =>
        fs.stat(marker + suffix).then(
          () => true,
          () => false,
        ),
      );
      assert.equal(JSON.parse(await fs.readFile(marker + suffix, 'utf8')).cancelled, true);
      assert.equal((await runtime.state()).sessionId, f.session.header.id);
      assert.equal(runtime.child.exitCode, null);
      const claim = await readClaim(f.bridge.pool.attachmentDir, f.session);
      assert.equal(claim.generation, generation);
      assert.equal(await ownerAlive(claim.owner), true);
      assert.equal(await readClaim(f.bridge.pool.attachmentDir, b), null);
    }
    await assert.rejects(fs.stat(marker + '.with-session'), { code: 'ENOENT' });
    await assert.rejects(fs.stat(marker + '.setup'), { code: 'ENOENT' });
    assert.deepEqual(await fs.readFile(b.file), bytes);
    f.config.grants = [{ session_id: f.id, list: true, read: true }];
    await f.bridge.read({ session_id: f.id });
    await f.bridge.list({ session_id: f.id });
    assert.equal(runtime.child.exitCode, null);
  },
);
