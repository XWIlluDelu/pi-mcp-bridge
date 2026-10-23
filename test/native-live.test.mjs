import { denyAllPermissions } from './fixtures/permissions.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn) {
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    const result = await fn();
    if (result) return result;
    await delay(10);
  }
  throw new Error('NATIVE_LIVE_TIMEOUT');
}

async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-native-live-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true }],
  };
  config.piArgs.push(
    '-e',
    path.resolve('test/fixtures/faux-extension.mjs'),
    '-e',
    path.resolve('test/fixtures/live-stream-gate.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
    '--thinking',
    'off',
  );
  const bridge = await new Bridge(config).init(),
    made = await savedSession(bridge),
    session = await bridge.session(made.session_id);
  const finish = (run) => fs.writeFile(path.join(dir, 'finish-live-stream-' + run), 'go');
  t.after(async () => {
    await Promise.all([finish(1), finish(2)]);
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  return { bridge, session, finish };
}

test(
  'owned native RPC exposes partial text separately, then hands off to finalized timeline without cursor invalidation',
  { timeout: 15000 },
  async (t) => {
    const { bridge, session, finish } = await fixture(t);
    const status = async () => (await bridge.list({ session_id: session.id })).sessions[0].status;
    const saved = await status();
    assert.equal(saved.state, 'saved');
    assert.equal(Object.hasOwn(saved, 'capabilities'), false);
    await bridge.send({ session_id: session.id, text: 'STREAM_PARTIAL' });
    const live = await until(async () => {
      const result = await bridge.read({ session_id: session.id, max_bytes: 4096 });
      return result.live?.items?.some((unit) => unit.block?.type === 'text' && unit.block.text)
        ? result
        : null;
    });
    const busy = await status();
    assert.equal(busy.state, 'busy');
    assert.deepEqual(busy.capabilities, { send: true, command: true, stop: true });
    assert.equal(live.live.source, 'rpc_message_events');
    assert.equal(live.live.transient, true);
    assert.ok(!live.items.some((item) => item.type === 'text'));
    assert.ok(Buffer.byteLength(JSON.stringify(live)) <= 4096);
    const historical = await bridge.read({
      session_id: session.id,
      leaf_id: live.leaf_id,
      max_bytes: 4096,
    });
    assert.equal(historical.live, null);
    await finish(1);
    await until(() => !bridge.pool.get(session.id) && !bridge.autoReleases.size);
    assert.equal((await status()).state, 'saved');
    assert.equal(Object.hasOwn(await status(), 'capabilities'), false);
    const final = await bridge.read({ session_id: session.id, max_bytes: 4096 });
    assert.equal(final.live.available, false);
    assert.equal(final.live.reason, 'native_events_unavailable');
    assert.ok(final.items.some((item) => item.type === 'text'));
    const fixed = await bridge.read({
      session_id: session.id,
      leaf_id: live.leaf_id,
      max_bytes: 4096,
    });
    assert.deepEqual(fixed.items, historical.items);
    assert.equal(fixed.leaf_id, historical.leaf_id);
  },
);

test(
  'a second native prompt cannot donate its preview to an earlier captured history',
  { timeout: 15000 },
  async (t) => {
    const { bridge, session, finish } = await fixture(t);
    await bridge.send({ session_id: session.id, text: 'PROMPT_A' });
    const rpc = bridge.pool.get(session.id);
    await until(() => rpc.liveMessage.snapshot().message?.content.some((b) => b.text));
    const dispatch = rpc.dispatch,
      captured = Promise.withResolvers(),
      resume = Promise.withResolvers();
    let capture = false,
      holding = false;
    t.after(() => resume.resolve());
    t.mock.method(rpc, 'dispatch', async function (command, ...args) {
      if (capture && !holding && command.type === 'get_state') {
        holding = true;
        captured.resolve();
        await resume.promise;
      }
      const result = await dispatch.call(this, command, ...args);
      if (command.type === 'get_entries') capture = true;
      return result;
    });
    const reading = bridge.read({ session_id: session.id, max_bytes: 4096 });
    await captured.promise;
    await finish(1);
    await until(() => rpc.settlement.sequence > 0);
    await bridge.send({ session_id: session.id, text: 'PROMPT_B' });
    await until(() => rpc.liveMessage.snapshot().message?.content.some((b) => b.text));
    resume.resolve();
    const earlier = await reading;
    assert.equal(
      earlier.items.filter((i) => i.type === 'prompt').at(-1).message.content[0].text,
      'PROMPT_A',
    );
    assert.equal(earlier.live.available, false);
    assert.equal(earlier.live.reason, 'context_changed_during_read');
    const current = await bridge.read({ session_id: session.id, max_bytes: 4096 });
    const lastPrompt = current.items.filter((i) => i.type === 'prompt').at(-1);
    assert.equal(lastPrompt.message.content[0].text, 'PROMPT_B');
    assert.equal(current.live.prompt_id, lastPrompt.prompt_id);
  },
);
