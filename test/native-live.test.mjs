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

test(
  'owned native RPC exposes partial text separately, then hands off to finalized timeline without cursor invalidation',
  { timeout: 15000 },
  async (t) => {
    const dir = await fs.mkdtemp('/tmp/pi-native-live-'),
      cwd = path.join(dir, 'project');
    await fs.mkdir(cwd);
    const config = {
      ...isolatedRuntime(dir),
      principal: 'native-live',
      defaults: denyAllPermissions(),
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ id: 'p', path: cwd }],
      grants: [{ folder: cwd, read: true, send: true }],
    };
    config.piArgs.push(
      '-e',
      path.resolve('test/fixtures/faux-extension.mjs'),
      '--provider',
      'bridge-fixture',
      '--model',
      'deterministic',
      '--thinking',
      'off',
    );
    const bridge = await new Bridge(config).init(),
      made = await savedSession(bridge, { folder_id: 'p' }),
      session = await bridge.session(made.session_id);
    t.after(async () => {
      await bridge.close();
      await fs.rm(dir, { recursive: true, force: true });
    });
    await bridge.send({ session_id: session.id, request_id: 'stream', text: 'STREAM_PARTIAL' });
    const live = await until(async () => {
      const result = await bridge.read({ session_id: session.id, max_bytes: 4096 });
      return result.live?.message?.content.some((block) => block.type === 'text' && block.text)
        ? result
        : null;
    });
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
    await until(async () => !(await bridge.pool.get(session.id).state()).isStreaming);
    const final = await bridge.read({ session_id: session.id, max_bytes: 4096 });
    assert.equal(final.live.message, null);
    assert.ok(final.items.some((item) => item.type === 'text'));
    const fixed = await bridge.read({
      session_id: session.id,
      leaf_id: live.leaf_id,
      max_bytes: 4096,
    });
    assert.equal(fixed.snapshot, historical.snapshot);
  },
);
