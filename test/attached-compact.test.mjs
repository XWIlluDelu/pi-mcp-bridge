import { ackTimeout } from './fixtures/ack-timeout.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRpcHostBinding } from '../src/runtime/host-bindings.mjs';
import { launchProfile } from '../src/runtime/pi-installation.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';
import { nativeRpc, nativeRpcHost } from './fixtures/native-rpc.mjs';
const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

async function attached(t, route) {
  const f = await fixture(t);
  const env = { ...launchProfile(f.config).env, ...f.env };
  let client, controller;
  if (route === 'binding') {
    ({ client, controller } = await nativeRpcHost(f, { env, args: f.config.piArgs }));
    await controller.ready(createRpcHostBinding(client));
  } else {
    client = await nativeRpc(f, {
      env,
      args: [
        '--session',
        f.session.file,
        ...f.config.piArgs,
        '-e',
        path.resolve('src/attach-extension.mjs'),
      ],
    });
  }
  await client.prompt('KEEP_HISTORY '.repeat(200));
  await until(async () => !(await client.getState()).isStreaming);
  return { ...f, client, controller };
}
for (const route of ['companion', 'binding']) {
  test(
    `${route} compaction enforces permission/admission, completes natively and redacts summary`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route),
        args = { session_id: f.id };
      if (route === 'binding')
        assert.equal((await f.bridge.compact(args)).reason, 'COMPACT_IDLE_UNCONFIRMED');
      await f.client.prompt('HOLD_MODEL');
      await until(() => exists(f.gate + '.provider-start'));
      assert.equal((await f.bridge.compact(args)).reason, 'COMPACT_BUSY');
      assert.equal(await exists(f.gate + '.provider-aborted'), false);
      await fs.writeFile(
        f.configFile,
        JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
      );
      await assert.rejects(f.bridge.compact({ ...args, interrupt: true }), /NOT_FOUND_OR_DENIED/);
      await fs.writeFile(
        f.configFile,
        JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true, stop: true }] }),
      );
      const result = await f.bridge.compact({
        ...args,
        interrupt: true,
        instructions: 'PRIVATE_SUMMARY',
      });
      assert.equal(result.status, 'completed', JSON.stringify(result));
      assert.equal(result.interrupt_requested, true);
      assert.ok(!JSON.stringify(result).includes('PRIVATE_SUMMARY'));
      await assert.rejects(f.bridge.read(args), /NOT_FOUND_OR_DENIED/);
      const entries = (await f.client.getEntries()).entries;
      assert.equal(entries.filter((e) => e.type === 'compaction').length, 1);
      assert.ok(entries.find((e) => e.type === 'compaction').summary.includes('PRIVATE_SUMMARY'));
      assert.equal(await exists(f.gate + '.provider-aborted'), true);
    },
  );
  test(
    `${route} compaction timeout never replays and keeps its pending input fence until native completion`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route);
      if (route === 'binding') ackTimeout(t, ['compact']);
      const result = await f.bridge.compact({
        session_id: f.id,
        interrupt: true,
        instructions: 'HOLD_COMPACT',
      });
      assert.deepEqual(result, {
        status: 'unknown',
        reason: 'ACK_TIMEOUT',
        native_effects: 'native_compact_attempted',
      });
      await until(() => exists(f.gate + '.compact-start'));
      assert.equal(
        (await f.bridge.send({ session_id: f.id, text: 'NOT_SENT' })).reason,
        'COMPACTION_PENDING',
      );
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        0,
      );
      await fs.writeFile(f.gate, 'go');
      await until(
        async () =>
          (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length === 1,
      );
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        1,
      );
      assert.match(
        JSON.stringify(await f.bridge.read({ session_id: f.id, view: 'session' })),
        /Native fixture summary HOLD_COMPACT/,
      );
    },
  );
  test(
    `${route} native compaction cancellation has no successful receipt or summary`,
    { timeout: 15000 },
    async (t) => {
      const f = await attached(t, route);
      const result = await f.bridge.compact({
        session_id: f.id,
        interrupt: true,
        instructions: 'CANCEL_COMPACT',
      });
      assert.equal(
        result.status,
        route === 'companion' ? 'rejected' : 'unknown',
        JSON.stringify(result),
      );
      assert.equal(result.reason, route === 'companion' ? 'PI_REJECTED' : 'HOST_COMPACT_UNCERTAIN');
      assert.equal(
        (await f.client.getEntries()).entries.filter((e) => e.type === 'compaction').length,
        0,
      );
    },
  );
}

test(
  'companion idle compact needs only send and fences native input until completion',
  { timeout: 15000 },
  async (t) => {
    const f = await attached(t, 'companion');
    await fs.writeFile(
      f.configFile,
      JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
    );
    const preflight = f.client.prompt('HOLD_PREFLIGHT');
    await until(() => exists(f.gate + '.preflight-start'));
    assert.equal((await f.bridge.compact({ session_id: f.id })).reason, 'COMPACT_BUSY');
    await fs.writeFile(f.gate + '.preflight-release', 'go');
    await preflight;
    const compacting = f.bridge.compact({ session_id: f.id, instructions: 'HOLD_COMPACT' });
    await until(() => exists(f.gate + '.compact-start'));
    await assert.rejects(f.client.prompt('MUST_NOT_RUN_DURING_COMPACT'), /COMPACTION_PENDING/);
    await fs.writeFile(f.gate, 'go');
    const result = await compacting;
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(result.interrupt_requested, false);
    const entries = (await f.client.getEntries()).entries;
    assert.ok(!JSON.stringify(entries).includes('MUST_NOT_RUN_DURING_COMPACT'));
    assert.equal(entries.filter((entry) => entry.type === 'compaction').length, 1);
  },
);
