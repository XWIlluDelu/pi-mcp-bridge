import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fixture, idle, until, choice } from './fixtures/model-runtime.mjs';
import { Bridge } from '../src/bridge.mjs';
import { ownerAlive, readClaim } from '../src/attachments.mjs';
test('reload rechecks authorization after idle proof and never tears down a mismatched native identity', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.models({ session_id: id, start: true });
  const runtime = bridge.pool.get(id),
    owner = runtime.ownerRecord.owner,
    dispatch = runtime.dispatch.bind(runtime);
  runtime.dispatch = async (command) => {
    const result = await dispatch(command);
    return command.type === 'get_state'
      ? { ...result, sessionId: 'another-native-session' }
      : result;
  };
  try {
    const refused = await bridge.reload({ session_id: id, request_id: 'identity' });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'RUNTIME_SESSION_CHANGED');
    assert.equal(await ownerAlive(owner), true);
    assert.equal(runtime.gracefulExitPromise, undefined);
  } finally {
    runtime.dispatch = dispatch;
  }
  const assertIdle = runtime.assertIdle.bind(runtime);
  runtime.assertIdle = async (args) => {
    const state = await assertIdle(args);
    await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
    return state;
  };
  const revoked = await bridge.reload({ session_id: id, request_id: 'revoked' });
  assert.equal(revoked.status, 'rejected');
  assert.equal(revoked.reason, 'NOT_FOUND_OR_DENIED');
  assert.equal(await ownerAlive(owner), true);
  assert.equal(runtime.gracefulExitPromise, undefined);
});

test('reload cannot overwrite a local handoff reserved during owner lookup', async (t) => {
  const { bridge, id } = await fixture(t);
  await bridge.models({ session_id: id, start: true });
  const runtime = bridge.pool.get(id),
    marker = { controller: new AbortController() };
  const forRead = bridge.pool.forRead.bind(bridge.pool);
  t.mock.method(bridge.pool, 'forRead', async (session) => {
    const r = await forRead(session);
    bridge.handoffs.set(id, marker);
    return r;
  });
  try {
    const result = await bridge.reload({ session_id: id, request_id: 'handoff-race' });
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason, 'HANDOFF_PENDING');
    assert.strictEqual(bridge.handoffs.get(id), marker);
    assert.equal(runtime.gracefulExitPromise, undefined);
  } finally {
    bridge.handoffs.delete(id);
  }
});

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );

test('idle rpc reopen preserves committed context and identity, reapplies native launch settings, and replays without another exit', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  const inactive = await bridge.reload({ session_id: id, request_id: 'inactive' });
  assert.equal(inactive.reason, 'RELOAD_NOT_RUNNING');
  assert.equal(bridge.pool.instances.size, 0);
  await bridge.send({ session_id: id, request_id: 'context', text: 'PERSISTED_CONTEXT' });
  const old = bridge.pool.get(id);
  await idle(old);
  const selected = await bridge.set_model({
    session_id: id,
    request_id: 'choice',
    model: choice('vision'),
    thinking_level: 'high',
  });
  assert.equal(selected.status, 'accepted', JSON.stringify(selected));
  assert.equal(selected.thinking_level, 'high');
  const before = await old.entries(),
    owner = old.ownerRecord,
    generation = old.generation,
    native = (await old.state()).sessionId;
  // Normal cold resume must restore session selection if no CLI override replaces it.
  f.config.piArgs.splice(f.config.piArgs.indexOf('--provider'), 2);
  f.config.piArgs.splice(f.config.piArgs.indexOf('--model'), 2);
  f.config.piArgs.splice(f.config.piArgs.indexOf('--thinking'), 2);
  const fresh = await bridge.reload({ session_id: id, request_id: 'reopen' });
  assert.equal(fresh.status, 'accepted', JSON.stringify(fresh));
  assert.equal(fresh.method, 'rpc_reopen');
  assert.equal(fresh.previous_generation, generation);
  assert.notEqual(fresh.generation, generation);
  const next = bridge.pool.get(id);
  assert.equal(await ownerAlive(owner.owner), false);
  assert.notEqual(next.child.pid, old.child.pid);
  assert.equal((await next.state()).sessionId, native);
  assert.equal(next.session.file, old.session.file);
  assert.equal(fresh.model.id, 'vision');
  assert.equal(fresh.thinking_level, 'high');
  const after = await next.entries();
  for (const entry of before.entries)
    assert.deepEqual(
      after.entries.find((e) => e.id === entry.id),
      entry,
    );
  assert.equal(after.entries.filter((e) => e.message?.role === 'user').length, 1);
  assert.deepEqual(await bridge.reload({ session_id: id, request_id: 'reopen' }), fresh);
  assert.equal(bridge.pool.get(id), next);
  const claim = await readClaim(bridge.pool.attachmentDir, next.session);
  assert.equal(claim.generation, next.ownerRecord.generation);
  assert.equal(claim.owner.pid, next.child.pid);
  // Owner launch arguments intentionally override saved choice on cold reopen.
  f.config.piArgs.push('--provider', 'model-fixture', '--model', 'alpha', '--thinking', 'off');
  const changed = await bridge.reload({ session_id: id, request_id: 'new-launch-default' });
  assert.equal(changed.status, 'accepted');
  assert.equal(changed.model.id, 'alpha');
  assert.equal(changed.thinking_level, 'off');
  assert.deepEqual(await bridge.reload({ session_id: id, request_id: 'reopen' }), fresh);
  assert.equal((await bridge.pool.get(id).state()).model.id, 'alpha');
});

test('reload requires send only, refuses busy/unconfirmed idle without cancelling or exiting', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await fs.writeFile(
    f.configFile,
    JSON.stringify({ ...f.config, grants: [{ folder: f.cwd, send: true }] }),
  );
  await bridge.send({ session_id: id, request_id: 'held', text: 'HOLD_MODEL' });
  const runtime = bridge.pool.get(id),
    pid = runtime.child.pid;
  const busy = await bridge.reload({ session_id: id, request_id: 'busy' });
  assert.equal(busy.status, 'rejected');
  assert.equal(busy.reason, 'RELOAD_BUSY');
  assert.equal(runtime.gracefulExitPromise, undefined);
  assert.equal((await runtime.state()).isStreaming, true);
  await fs.writeFile(f.gate, 'go');
  await idle(runtime);
  const socket = runtime.ownerRecord.socket;
  runtime.ownerRecord.socket = undefined;
  try {
    const denied = await bridge.reload({ session_id: id, request_id: 'unproven' });
    assert.equal(denied.reason, 'RELOAD_IDLE_UNCONFIRMED');
  } finally {
    runtime.ownerRecord.socket = socket;
  }
  assert.equal(runtime.child.pid, pid);
  assert.equal(runtime.gracefulExitPromise, undefined);
  const reloaded = await bridge.reload({ session_id: id, request_id: 'send-only' });
  assert.equal(reloaded.status, 'accepted', JSON.stringify(reloaded));
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, grants: [] }));
  await assert.rejects(
    bridge.reload({ session_id: id, request_id: 'send-only' }),
    /NOT_FOUND_OR_DENIED/,
  );
});

test('timeout leaves normal EOF pending without force kill; identical request observes phases, then durable completion', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.models({ session_id: id, start: true });
  const old = bridge.pool.get(id),
    owner = old.ownerRecord.owner;
  await fs.writeFile(f.gate + '.hold-shutdown', 'hold');
  const unknown = await bridge.reload({
    session_id: id,
    request_id: 'slow-reopen',
    timeout_ms: 50,
  });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.reason, 'ACK_TIMEOUT');
  await until(() => exists(f.gate + '.shutdown-start'));
  assert.equal(await ownerAlive(owner), true);
  const pending = await bridge.reload({ session_id: id, request_id: 'slow-reopen' });
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.phase, 'exiting');
  const blocked = await bridge.send({ session_id: id, request_id: 'blocked', text: 'NEVER' });
  assert.equal(blocked.reason, 'HANDOFF_PENDING');
  await fs.writeFile(f.gate + '.exit', 'go');
  await until(async () => (await bridge.journal.get('slow-reopen')).receipt.status === 'accepted');
  const done = await bridge.reload({ session_id: id, request_id: 'slow-reopen' });
  assert.equal(done.phase, 'completed');
  assert.equal(await ownerAlive(owner), false);
  assert.equal(
    (await bridge.pool.get(id).entries()).entries.filter((e) => e.message?.role === 'user').length,
    0,
  );
  await bridge.close();
  const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
  try {
    assert.deepEqual(await restarted.reload({ session_id: id, request_id: 'slow-reopen' }), done);
    assert.equal(restarted.pool.instances.size, 0);
  } finally {
    await restarted.close();
  }
});

test('failed replacement stays unknown with exited phase and does not retry a factory on recovery', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.models({ session_id: id, start: true });
  const old = bridge.pool.get(id),
    owner = old.ownerRecord.owner;
  let attempts = 0;
  bridge.pool.factory = async () => {
    attempts++;
    throw new Error('RUNTIME_START_FAILED');
  };
  const failed = await bridge.reload({ session_id: id, request_id: 'fail-start' });
  assert.equal(failed.status, 'unknown');
  assert.equal(failed.reason, 'RUNTIME_START_FAILED');
  assert.equal(failed.phase, 'reopening');
  assert.equal(await ownerAlive(owner), false);
  assert.deepEqual(await bridge.reload({ session_id: id, request_id: 'fail-start' }), failed);
  assert.equal(attempts, 1);
  assert.equal(bridge.pool.instances.size, 0);
});

test('Bridge shutdown during EOF completes cleanup, saves uncertainty and does not spawn a replacement', async (t) => {
  const f = await fixture(t),
    { bridge, id } = f;
  await bridge.models({ session_id: id, start: true });
  const owner = bridge.pool.get(id).ownerRecord.owner;
  await fs.writeFile(f.gate + '.hold-shutdown', 'hold');
  assert.equal(
    (await bridge.reload({ session_id: id, request_id: 'closing', timeout_ms: 50 })).status,
    'unknown',
  );
  await until(() => exists(f.gate + '.shutdown-start'));
  const closing = bridge.close();
  await fs.writeFile(f.gate + '.exit', 'go');
  await closing;
  assert.equal(await ownerAlive(owner), false);
  const saved = (await bridge.journal.get('closing')).receipt;
  assert.equal(saved.status, 'unknown');
  assert.equal(saved.reason, 'BRIDGE_CLOSING');
  assert.equal(saved.phase, 'reopening');
  const restarted = await new Bridge(f.config, undefined, { configFile: f.configFile }).init();
  try {
    assert.deepEqual(await restarted.reload({ session_id: id, request_id: 'closing' }), saved);
    assert.equal(restarted.pool.instances.size, 0);
  } finally {
    await restarted.close();
  }
});
