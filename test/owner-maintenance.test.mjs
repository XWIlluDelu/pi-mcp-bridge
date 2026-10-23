import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, until, idle } from './fixtures/model-runtime.mjs';
import { ownerRequest } from '../src/owner-runtime.mjs';
import { readClaim, claimFile, ownerAlive } from '../src/attachments.mjs';

test(
  'explicit owner interruption recovers held native startup without changing the saved session',
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

      text: '/held-extension-input',
    });
    assert.equal(accepted.status, 'handled');
    await until(() =>
      fs.stat(marker).then(
        () => true,
        () => false,
      ),
    );
    const runtime = f.bridge.pool.get(f.id),
      previous = runtime.ownerRecord,
      session = runtime.session;
    assert.equal((await runtime.state()).isStreaming, true);
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id }),
      /RUNTIME_BUSY/,
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
      (await f.bridge.send({ session_id: f.id, text: 'NOT_SENT' })).reason,
      'COLD_REACQUIRE_BLOCKED',
    );
    await ownerRequest(f.config, { op: 'reset', session_id: f.id, confirm_local_closed: true });
    assert.ok(
      ['started', 'queued', 'handled'].includes(
        (await f.bridge.send({ session_id: f.id, text: 'AFTER_MAINTENANCE' })).status,
      ),
      'Expected native prompt admission',
    );
    const next = f.bridge.pool.get(f.id);
    await until(async () => (await next.idleSnapshot()).status === 'idle');
    assert.equal(next.session.file, session.file);
    assert.equal(next.session.header.id, session.header.id);
    assert.notEqual(next.generation, runtime.generation);
    const body = JSON.stringify(await f.bridge.read({ session_id: f.id }));
    assert.ok(body.includes('AFTER_MAINTENANCE'));
    assert.ok(!body.includes('UNFINISHED_EXTENSION_INPUT'));
  },
);

test('missing history does not strand a known owned writer', { timeout: 15000 }, async (t) => {
  for (const interrupt of [false, true]) {
    await t.test(interrupt ? 'explicit interruption' : 'normal EOF', async (t) => {
      const f = await fixture(t),
        session = await f.bridge.session(f.id),
        runtime = await f.bridge.pool.resolve(session),
        record = structuredClone(runtime.ownerRecord),
        removed = path.join(f.dir, 'removed-session.jsonl'),
        history = await fs.readFile(session.file),
        signals = [];
      const kill = runtime.child.kill.bind(runtime.child);
      t.mock.method(runtime.child, 'kill', (signal) => {
        signals.push(signal);
        return kill(signal);
      });
      await fs.rename(session.file, removed);
      const result = await ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt });
      assert.equal(result.status, 'released');
      assert.equal(result.no_cold_reacquire, true);
      assert.equal(await ownerAlive(record.owner), false);
      assert.deepEqual(signals, interrupt ? ['SIGTERM'] : []);
      if (!interrupt) {
        assert.equal(runtime.child.exitCode, 0);
        assert.equal(runtime.child.signalCode, null);
      }
      assert.equal(f.bridge.pool.get(f.id), null);
      const released = await readClaim(f.bridge.pool.attachmentDir, session);
      assert.equal(released.generation, record.generation);
      assert.equal(released.phase, 'released');
      assert.equal(released.owner, null);
      await assert.rejects(fs.stat(session.file), { code: 'ENOENT' });
      assert.deepEqual(await fs.readFile(removed), history);
    });
  }
});

test(
  'missing-history release rejects a changed claim and a replacement history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      session = await f.bridge.session(f.id),
      runtime = await f.bridge.pool.resolve(session),
      file = claimFile(f.bridge.pool.attachmentDir, session),
      original = await fs.readFile(file, 'utf8'),
      record = JSON.parse(original),
      history = await fs.readFile(session.file),
      signals = [];
    const kill = runtime.child.kill.bind(runtime.child);
    t.mock.method(runtime.child, 'kill', (signal) => {
      signals.push(signal);
      return kill(signal);
    });
    await fs.unlink(session.file);
    try {
      for (const changed of [
        { ...record, generation: 'another-generation' },
        { ...record, owner: { ...record.owner, start: 'another-process-start' } },
      ]) {
        const bytes = JSON.stringify(changed);
        await fs.writeFile(file, bytes);
        for (const interrupt of [false, true]) {
          await assert.rejects(
            ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt }),
            /RUNTIME_SESSION_CHANGED/,
          );
          assert.equal(await fs.readFile(file, 'utf8'), bytes);
          assert.equal(runtime.child.stdin.writableEnded, false);
        }
      }
      await fs.writeFile(file, original);
      const lines = history.toString().split('\n'),
        replacement = JSON.parse(lines[0]);
      replacement.id = 'replacement-native-session';
      lines[0] = JSON.stringify(replacement);
      const bytes = lines.join('\n');
      await fs.writeFile(session.file, bytes);
      for (const interrupt of [false, true]) {
        await assert.rejects(
          ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt }),
          /NOT_FOUND_OR_DENIED/,
        );
      }
      assert.equal(await fs.readFile(session.file, 'utf8'), bytes);
      assert.equal(await ownerAlive(record.owner), true);
      assert.equal(runtime.child.stdin.writableEnded, false);
      assert.deepEqual(signals, []);
    } finally {
      await fs.writeFile(file, original);
      await fs.writeFile(session.file, history);
    }
  },
);

test('missing history without an owned writer cannot release an arbitrary claim', async (t) => {
  const f = await fixture(t),
    session = await f.bridge.session(f.id);
  await fs.unlink(session.file);
  for (const interrupt of [false, true]) {
    await assert.rejects(
      ownerRequest(f.config, { op: 'release', session_id: f.id, interrupt }),
      /NOT_FOUND_OR_DENIED/,
    );
  }
  assert.equal(f.bridge.pool.instances.size, 0);
  assert.equal(await readClaim(f.bridge.pool.attachmentDir, session), null);
});

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
        ['command', { command: 'echo NOT_RUN' }],
        ['stop', {}],
      ]) {
        const result = await f.bridge[op]({
          session_id: f.id,

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
    runtime.trackAck(async () => {
      await gate.promise;
      await runtime.state();
      captured = true;
    });
    const drain = runtime.drainAcks.bind(runtime),
      exit = runtime.gracefulExit.bind(runtime);
    runtime.drainAcks = () => {
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
