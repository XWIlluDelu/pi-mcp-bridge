import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { READ_CONTRACT, assertReadSnapshot } from '../src/context-read.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
import { reserveOwner, updateOwner } from '../src/attachments.mjs';
import { callBridgeTool } from '../src/protocol.mjs';
import { companionHooks } from './fixtures/companion.mjs';
import { SessionManager, buildSessionProjection } from './fixtures/pi.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';
import { append, message, text } from './fixtures/native-history.mjs';
import { readSource } from './fixtures/read-source.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';

const image = { type: 'image', mimeType: 'image/png', data: 'A'.repeat(50000) };
const entries = [
  message('s', null, 'system', 'READ_RULES', {
    toolsAdded: [{ name: 'declared', description: 'tool' }],
  }),
  message('u', 's', 'user', [text('FIRST_TASK'), image]),
  message('a', 'u', 'assistant', [text('Earlier reply. '.repeat(400))]),
  message('later', 'a', 'user', 'LATER_TASK'),
];

async function attach(f, kind, projection = buildSessionProjection) {
  if (kind === 'host') {
    const controller = await reserveHostSession({
      attachmentDir: f.config.attachmentDir,
      session: f.session,
      buildSessionProjection: projection,
    });
    f.cleanup.push(() => controller.close());
    const manager = SessionManager.open(f.session.file);
    const state = () => ({ sessionFile: f.session.file, sessionId: f.session.header.id });
    await controller.ready({
      state,
      snapshot: () => ({ ...state(), entries: manager.getEntries(), leafId: manager.getLeafId() }),
      submit: () => assert.fail('Read must not submit work'),
    });
    return;
  }
  const handlers = await companionHooks(f, projection);
  await handlers.session_start(
    {},
    {
      mode: 'tui',
      sessionManager: SessionManager.open(f.session.file),
      isIdle: () => true,
      hasPendingMessages: () => false,
      shutdown: () => assert.fail('Read must not shut down owner'),
    },
  );
}

for (const kind of ['host', 'companion']) {
  test(
    kind + ' uses its bound projection and keeps sanitized reads separate from raw fork snapshots',
    async (t) => {
      const f = await nativeOwner(t, { prefix: 'read-owner' });
      await append(f.session, entries);
      const request = { session_id: f.id, leaf_id: 'a', max_bytes: 4096 };
      const saved = await readSource(f.bridge, request);
      const leaves = [];
      await attach(f, kind, (...args) => {
        leaves.push(args[1]);
        return buildSessionProjection(...args);
      });
      const runtime = await f.bridge.pool.forRead(f.session);
      f.config.piExecutable = path.join(f.dir, 'missing-pi');
      assert.deepEqual((await readSource(f.bridge, request)).items, saved.items);
      const captured = await runtime.read(request);
      assert.equal(captured.contract, READ_CONTRACT);
      assert.equal(captured.omissions.system, 1);
      assert.doesNotMatch(JSON.stringify(captured), /READ_RULES|AAAAAAA|LATER_TASK/);
      const current = await runtime.read({ session_id: f.id, content: ALL_CONTENT });
      assert.equal(current.leaf_id, 'later');
      assert.match(JSON.stringify(current.units), /READ_RULES.*declared/);
      assert.deepEqual(leaves, ['a', 'a', 'later']);
      const raw = await runtime.snapshot();
      assert.deepEqual(raw.entries.find((entry) => entry.id === 'u').message.content[1], image);
      assert.equal(raw.leafId, 'later');
    },
  );
}

test('read contract is independent of product version and a mismatch cannot replace the writer', async (t) => {
  const f = await nativeOwner(t, { prefix: 'read-contract' });
  await attach(f, 'host');
  const runtime = await f.bridge.pool.forRead(f.session);
  await updateOwner(f.config.attachmentDir, f.session, runtime.record, {
    bridgeVersion: 'different-product-version',
  });
  await runtime.readFeatures();
  const request = { session_id: f.id };
  const snapshot = await runtime.read(request);
  assert.throws(
    () => assertReadSnapshot({ ...snapshot, contract: 'unsupported' }),
    /OWNER_READ_REFRESH_REQUIRED/,
  );
  t.mock.method(runtime, 'request', () => assert.fail('Do not probe an incompatible owner'));
  runtime.record.readContract = 'unsupported';
  const result = await callBridgeTool(f.bridge, 'read', request);
  assert.equal(result.structuredContent.error.code, 'OWNER_READ_REFRESH_REQUIRED');
  await assert.rejects(
    reserveOwner(f.config.attachmentDir, f.session, 'rpc'),
    /LIVE_OWNER_UNREACHABLE/,
  );
});
