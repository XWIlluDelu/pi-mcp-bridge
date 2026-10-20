import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, until, idle } from './fixtures/model-runtime.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { readClaim, ownerAlive } from '../src/attachments.mjs';

test(
  'explicit owner interruption recovers unobservable preflight without changing the saved session',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      marker = path.join(f.dir, 'preparing'),
      extension = path.join(f.dir, 'preflight.mjs');
    await fs.writeFile(
      extension,
      `import fs from 'node:fs/promises';
    export default pi => {
      pi.registerCommand('held-extension-input', { handler: () => { pi.sendUserMessage('UNFINISHED_EXTENSION_INPUT'); } });
      pi.on('before_agent_start', async e => {
        if (e.prompt !== 'UNFINISHED_EXTENSION_INPUT') return;
        await fs.writeFile(${JSON.stringify(marker)}, 'yes');
        await new Promise(() => {});
      });
    };`,
    );
    f.config.piArgs.push('-e', extension);
    // The fixture reloads grants only; its launch profile is the same in-memory object.
    const accepted = await f.bridge.send({
      session_id: f.id,
      request_id: 'held',
      text: '/held-extension-input',
    });
    assert.equal(accepted.disposition, 'handled');
    await until(() =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    const runtime = f.bridge.pool.get(f.id),
      previous = runtime.ownerRecord,
      session = runtime.session;
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id }),
      /RUNTIME_IDLE_UNCONFIRMED/,
    );
    const signals = [],
      kill = runtime.child.kill.bind(runtime.child);
    runtime.child.kill = (signal) => {
      signals.push(signal);
      return kill(signal);
    };
    assert.equal(
      (await ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt: true })).status,
      'released',
    );
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(await ownerAlive(previous.owner), false);
    assert.equal((await readClaim(f.bridge.pool.attachmentDir, session)).noColdReacquire, true);
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'held-fence', text: 'NOT_SENT' }))
        .reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    await ownerRequest(f.config, { op: 'reset', session_id: f.id, confirm_local_closed: true });
    assert.equal(
      (await f.bridge.send({ session_id: f.id, request_id: 'resumed', text: 'AFTER_MAINTENANCE' }))
        .status,
      'accepted',
    );
    const next = f.bridge.pool.get(f.id);
    await idle(next);
    assert.equal(next.session.file, session.file);
    assert.equal(next.session.header.id, session.header.id);
    assert.notEqual(next.generation, runtime.generation);
    await next.assertReleasable();
    const body = JSON.stringify(await f.bridge.read({ session_id: f.id }));
    assert.ok(body.includes('AFTER_MAINTENANCE'));
    assert.ok(!body.includes('UNFINISHED_EXTENSION_INPUT'));
  },
);

test(
  'release fences new mutations, drains admitted stop and uses normal EOF',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await f.bridge.pool.resolve(await f.bridge.session(f.id)),
      gate = Promise.withResolvers(),
      entered = Promise.withResolvers();
    f.config.grants[0].command = true;
    await fs.writeFile(f.configFile, JSON.stringify(f.config));
    const stopping = f.bridge.locked('stop:' + f.id, async () => {
      entered.resolve();
      await gate.promise;
    });
    t.after(() => gate.resolve());
    await entered.promise;
    const release = f.bridge.releaseForLocal({ session_id: f.id });
    const signals = [],
      kill = runtime.child.kill.bind(runtime.child);
    runtime.child.kill = (signal) => {
      signals.push(signal);
      return kill(signal);
    };
    assert.equal(f.bridge.handoffs.get(f.id).kind, 'release');
    try {
      for (const [op, body] of [
        ['send', { text: 'NOT_SENT' }],
        ['set_model', { thinking_level: 'high' }],
        ['command', { command: 'echo NOT_RUN' }],
        ['stop', {}],
        ['reload', {}],
      ]) {
        const result = await f.bridge[op]({
          session_id: f.id,
          request_id: 'blocked-' + op,
          ...body,
        }).catch((error) => ({ reason: error.code ?? error.message }));
        assert.ok(
          ['HANDOFF_PENDING', 'STOP_IN_PROGRESS'].includes(result.reason),
          JSON.stringify(result),
        );
      }
      await assert.rejects(
        f.bridge.releaseForLocal({ session_id: f.id, interrupt: true }),
        /HANDOFF_PENDING/,
      );
      assert.equal(runtime.child.exitCode, null);
      assert.deepEqual(signals, []);
    } finally {
      gate.resolve();
      await Promise.allSettled([stopping, release]);
    }
    await stopping;
    assert.equal((await release).status, 'released');
    assert.deepEqual(signals, []);
    assert.equal(runtime.child.exitCode, 0);
    assert.equal(f.bridge.handoffs.has(f.id), false);
  },
);

test(
  'idle owner release drains late receipt capture before closing its native pipe',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await f.bridge.pool.resolve(await f.bridge.session(f.id)),
      gate = Promise.withResolvers(),
      first = Promise.withResolvers();
    let captured = false,
      exiting = false;
    runtime.trackRecovery(async () => {
      await gate.promise;
      await runtime.checkedState();
      captured = true;
    });
    const drain = runtime.drainRecovery.bind(runtime),
      exit = runtime.gracefulExit.bind(runtime);
    runtime.drainRecovery = () => {
      first.resolve('drain');
      return drain();
    };
    runtime.gracefulExit = () => {
      first.resolve('exit');
      exiting = true;
      return exit();
    };
    const release = f.bridge.releaseForLocal({ session_id: f.id });
    try {
      assert.equal(await first.promise, 'drain');
      assert.equal(exiting, false);
    } finally {
      gate.resolve();
      await Promise.allSettled([release]);
    }
    assert.equal((await release).status, 'released');
    assert.equal(captured, true);
    assert.equal(runtime.child.exitCode, 0);
  },
);

test(
  'all idle-gated controls ignore pending observations but await native mutation ACKs',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      runtime = await f.bridge.pool.resolve(await f.bridge.session(f.id));
    t.after(() => runtime.pending.delete('synthetic-pending'));
    for (const commandType of [
      'get_state',
      'get_entries',
      'get_available_models',
      'get_available_thinking_levels',
    ]) {
      runtime.pending.set('synthetic-pending', { commandType });
      await runtime.assertReleasable();
      await runtime.assertIdle();
      await runtime.waitForHandoff();
    }
    runtime.pending.set('synthetic-pending', { commandType: 'abort' });
    await assert.rejects(runtime.assertReleasable(), /RUNTIME_BUSY/);
    await assert.rejects(runtime.assertIdle(), /MODEL_SELECTION_BUSY/);
    const controller = new AbortController();
    const waiting = runtime.waitForHandoff(controller.signal);
    controller.abort();
    await assert.rejects(waiting, { name: 'AbortError' });
    runtime.pending.delete('synthetic-pending');
    await runtime.assertReleasable();
    await runtime.waitForHandoff();
  },
);
