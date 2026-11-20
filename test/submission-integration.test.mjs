import { nativeOwner, fauxArgs, gatedExtension } from './fixtures/native-owner.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';
import { until } from './fixtures/until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { callBridgeTool } from '../src/mcp/protocol.mjs';

import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { ackTimeout } from './fixtures/ack-timeout.mjs';

async function fixture(t) {
  const calls = [];
  const runtime = ownedRuntime({
    generation: 'synthetic-submission-owner',
    state: async () => ({ isIdle: true }),
    command: async (command) => {
      calls.push(command);
      return { disposition: 'handled' };
    },
    stop: async () => {
      runtime.alive = false;
    },
  });
  const f = await nativeOwner(t, {
    prefix: 'submission',
    factory: async () => runtime,
    configure({ config }) {
      config.grants = [];
    },
  });
  return { ...f, project: f.cwd, calls, runtime };
}

test(
  'real Pi late ACK updates one submission without repeating the input',
  { timeout: 15000 },
  async (t) => {
    const f = await nativeOwner(t, {
      prefix: 'submission-ack',
      async configure(context) {
        context.config.piArgs.push(...fauxArgs);
        await gatedExtension(
          context,
          `
        pi.on('input', async () => {
          await fs.appendFile(dir + '/calls', 'input\\n');
          await wait('release-input');
          return { action: 'handled' };
        });
      `,
        );
        context.cleanup.push(() => fs.writeFile(path.join(context.dir, 'release-input'), 'go'));
      },
    });
    ackTimeout(t, ['prompt'], 50);
    const sent = await f.bridge.send({ session_id: f.id, text: 'ONCE' });
    assert.equal(sent.reason, 'ACK_TIMEOUT');
    const query = { session_id: f.id, submission_id: sent.submission_id };
    assert.equal((await f.bridge.submission(query)).receipt.status, 'unknown');
    await f.mark('release-input');
    await until(async () => (await f.bridge.submission(query)).receipt.status === 'handled');
    await until(() => !f.bridge.pool.get(f.id) && !f.bridge.autoReleases.size);
    assert.equal(await fs.readFile(path.join(f.dir, 'calls'), 'utf8'), 'input\n');
    t.mock.method(f.bridge.pool, 'forRead', () =>
      assert.fail('Receipt lookup must not contact an owner'),
    );
    const { structuredContent } = await callBridgeTool(f.bridge, 'submission', query);
    assert.deepEqual(structuredContent.receipt, { status: 'handled' });
  },
);

test('submission lookup checks current read/send/create grants and exact session without acquiring an owner', async (t) => {
  const f = await fixture(t);
  f.config.defaults = { ...denyAllPermissions(), create: true };
  const made = await f.bridge.create({ project: f.project, text: 'CREATE_ONLY_INPUT' });
  assert.equal(made.status, 'handled', JSON.stringify(made));
  const createQuery = { session_id: made.session_id, submission_id: made.submission_id };
  assert.equal((await f.bridge.submission(createQuery)).operation, 'create');
  f.config.defaults = { ...denyAllPermissions(), send: true };
  const sent = await f.bridge.send({ session_id: made.session_id, text: 'SEND_ONLY_INPUT' });
  assert.equal(sent.status, 'handled');
  const sendQuery = { session_id: made.session_id, submission_id: sent.submission_id };
  const other = await savedSession(f.bridge);
  t.mock.method(f.bridge.pool, 'resolve', () => assert.fail('Receipt query must not start Pi'));
  t.mock.method(f.bridge.pool, 'forRead', () =>
    assert.fail('Receipt query must not probe an owner'),
  );
  for (const grant of ['send', 'read']) {
    f.config.defaults = { ...denyAllPermissions(), [grant]: true };
    for (const query of [createQuery, sendQuery])
      assert.equal((await f.bridge.submission(query)).receipt.status, 'handled');
  }
  f.config.defaults = { ...denyAllPermissions(), create: true };
  assert.equal((await f.bridge.submission(createQuery)).receipt.status, 'handled');
  await assert.rejects(f.bridge.submission(sendQuery), /NOT_FOUND_OR_DENIED/);
  f.config.defaults = { ...denyAllPermissions(), read: true };
  await assert.rejects(
    f.bridge.submission({ ...sendQuery, session_id: other.session_id }),
    /SUBMISSION_UNAVAILABLE/,
  );
  f.config.defaults = denyAllPermissions();
  for (const query of [createQuery, sendQuery])
    await assert.rejects(f.bridge.submission(query), /NOT_FOUND_OR_DENIED/);
  assert.equal(f.calls.length, 2);
});

test('a native late ACK winning the timeout race removes the obsolete uncertainty reason', async (t) => {
  const f = await fixture(t);
  Object.assign(f.config.defaults, { send: true, create: true });
  f.runtime.command = async (_command, { onLate }) => {
    await onLate({ ok: true, data: { disposition: 'started' } });
    throw Object.assign(new Error('ACK_TIMEOUT'), { code: 'ACK_TIMEOUT', uncertain: true });
  };
  const saved = await savedSession(f.bridge);
  const sent = await f.bridge.send({ session_id: saved.session_id, text: 'RACE_INPUT' });
  assert.equal(sent.status, 'started');
  assert.equal(sent.reason, undefined);
  assert.deepEqual(
    (await f.bridge.submission({ session_id: saved.session_id, submission_id: sent.submission_id }))
      .receipt,
    { status: 'started' },
  );
  const made = await f.bridge.create({ project: f.project, text: 'RACE_CREATE_INPUT' });
  assert.equal(made.status, 'started');
  assert.equal(made.send.reason, undefined);
});
