import { nativeOwner } from './fixtures/native-owner.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { savedSession } from './fixtures/saved-session.mjs';

import { callBridgeTool } from '../src/mcp/protocol.mjs';
import { fixture as nativeFixture } from './fixtures/model-runtime.mjs';
import { ownedRuntime } from './fixtures/owned-runtime.mjs';
for (const operation of ['command', 'stop']) {
  test(
    operation + ' delivers admitted inline output after revocation and rejects a new request',
    async (t) => {
      const f = await nativeFixture(t),
        { bridge, id } = f;
      const marker = 'SYNTHETIC_PRIVATE_OUTPUT';
      Object.assign(f.config.grants[0], { command: true, read: false });
      await fs.writeFile(f.configFile, JSON.stringify(f.config));
      const runtime = await bridge.pool.resolve(f.session);
      if (operation === 'stop') {
        await bridge.send({ session_id: id, text: 'HOLD_MODEL' });
        await bridge.send({ session_id: id, text: marker, mode: 'follow_up' });
      }
      const method = operation === 'command' ? 'executeBash' : 'stopExecution';
      const native = runtime[method].bind(runtime);
      const captured = Promise.withResolvers(),
        publish = Promise.withResolvers();
      f.cleanup.unshift(() => publish.resolve());
      let calls = 0;
      t.mock.method(runtime, method, async (...args) => {
        calls++;
        const result = await native(...args);
        captured.resolve();
        await publish.promise;
        return result;
      });
      const args = {
        session_id: id,
        ...(operation === 'command' ? { command: 'printf ' + marker } : {}),
      };
      const pending = callBridgeTool(bridge, operation, args);
      await Promise.race([
        captured.promise,
        pending.then(() => assert.fail('Native output was not acquired')),
      ]);
      f.config.grants[0][operation] = false;
      await fs.writeFile(f.configFile, JSON.stringify(f.config));
      publish.resolve();
      assert.match(JSON.stringify(await pending), new RegExp(marker));
      const denied = await callBridgeTool(bridge, operation, args);
      assert.equal(denied.structuredContent.error.code, 'NOT_FOUND_OR_DENIED');
      assert.doesNotMatch(JSON.stringify(denied), new RegExp(marker));
      assert.equal(calls, 1);
    },
  );
}

async function fixture(t) {
  const runtime = ownedRuntime({ state: () => ({ isIdle: true }), stop: async () => {} });
  const f = await nativeOwner(t, {
    prefix: 'permissions',
    reloadConfig: true,
    factory: () => runtime,
  });
  return { ...f, runtime };
}

test('list keeps parent references from its snapshot through slow child status', async (t) => {
  const f = await fixture(t),
    parent = await savedSession(f.bridge),
    child = await savedSession(f.bridge);
  const parentSession = await f.bridge.session(parent.session_id),
    childSession = await f.bridge.session(child.session_id);
  await fs.writeFile(
    childSession.file,
    JSON.stringify({ ...childSession.header, parentSession: parentSession.file }) + '\n',
  );
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  f.runtime.state = async () => {
    entered.resolve();
    await release.promise;
    return { isIdle: true };
  };
  f.bridge.pool.instances.set(child.session_id, f.runtime);
  // Targeted listing must find the parent even if only the child's ID is warm.
  f.bridge.sessionFiles.delete(parent.session_id);
  const pending = f.bridge.list({ session_id: child.session_id });
  await entered.promise;
  const policy = {
    ...f.config,
    grants: [...f.config.grants, { session_id: parent.session_id, list: false }],
  };
  await fs.writeFile(f.configFile, JSON.stringify(policy));
  release.resolve();
  const result = await pending;
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].parent_session_id, parent.session_id);
  const fresh = await f.bridge.list({ session_id: child.session_id });
  assert.equal(fresh.sessions[0].parent_session_id, null);
});
