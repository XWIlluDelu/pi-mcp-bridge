import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, until, releasedEntries } from './fixtures/model-runtime.mjs';

test('owned idle_only skips independent native input preparation and admits input after it finishes', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f,
    rpc = await bridge.pool.resolve(await bridge.session(id));
  // This command acknowledges before the independent input handler finishes.
  // Native get_state still reports no active run or queued message.
  assert.equal(
    (await rpc.command({ type: 'prompt', message: '/fixture-independent-input HOLD_PREFLIGHT' }))
      .disposition,
    'handled',
  );
  await until(() =>
    fs.stat(f.gate + '.preflight-start').then(
      () => true,
      () => false,
    ),
  );
  const state = await rpc.state();
  assert.equal(state.isStreaming, false);
  assert.equal(state.pendingMessageCount, 0);
  assert.equal((await bridge.list({ session_id: id })).sessions[0].status.state, 'busy');

  const skipped = await bridge.send({ session_id: id, text: 'MUST_NOT_ENTER', mode: 'idle_only' });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'busy');
  assert.equal(
    (await rpc.entries()).entries.filter((entry) => entry.message?.role === 'user').length,
    0,
  );

  await fs.writeFile(f.gate + '.preflight-release', 'go');
  await until(async () => (await rpc.idleSnapshot()).status === 'idle');
  assert.equal(
    (await bridge.send({ session_id: id, text: 'AFTER_PREFLIGHT', mode: 'idle_only' })).status,
    'started',
  );
  const users = (await releasedEntries(bridge, id)).filter(
    (entry) => entry.message?.role === 'user',
  );
  assert.equal(users.length, 1);
  assert.ok(JSON.stringify(users[0]).includes('AFTER_PREFLIGHT'));
});
