import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { ALL_CONTENT } from '../src/read/read-schema.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { readSource } from './fixtures/read-source.mjs';
import { releasedEntries } from './fixtures/model-runtime.mjs';
import { ContextObservation } from '../src/read/context-observation.mjs';

async function fixture(t) {
  const f = await nativeOwner(t, {
    async configure({ dir, config }) {
      const transform = dir + '/transform.mjs';
      await fs.writeFile(
        transform,
        `
        export default pi => {
          pi.on('context', event => ({ messages: [
            { role: 'user', content: 'TRANSFORMED_SUMMARY_BODY', timestamp: 1 },
            ...event.messages.filter(m => !JSON.stringify(m).includes('DROP_FROM_REQUEST')),
          ] }));
          pi.on('before_agent_start', () => pi.appendEntry('run-count', {}));
          pi.on('context_with_system', event => {
            event.messages.push({ role: 'user', content: 'LATER_FULL_CONTEXT_HOOK', timestamp: 1 });
          });
        };
      `,
      );
      config.piArgs.push(...fauxArgs, '-e', transform, '--thinking', 'off');
    },
  });
  return f;
}

test(
  'runtime capture survives no-prompt cold starts and release, then updates on the next prompt',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const read = () => readSource(f.bridge, { session_id: f.id, view: 'runtime', max_bytes: 4096 });
    const release = () => releasedEntries(f.bridge, f.id);
    assert.equal((await read()).observation.reason, 'no_retained_observation');
    await f.bridge.send({ session_id: f.id, text: 'DROP_FROM_REQUEST' });
    await release();
    const before = await fs.readFile(f.session.file, 'utf8');
    const first = await read(),
      units = JSON.stringify(first.items);
    assert.equal(first.source, 'retained');
    assert.match(units, /TRANSFORMED_SUMMARY_BODY/);
    assert.doesNotMatch(units, /DROP_FROM_REQUEST|LATER_FULL_CONTEXT_HOOK|Synthetic response/);
    const native = await f.bridge.read({ session_id: f.id, content: ALL_CONTENT });
    assert.match(JSON.stringify(native.items), /DROP_FROM_REQUEST/);
    assert.equal(await fs.readFile(f.session.file, 'utf8'), before);
    assert.equal(f.bridge.pool.instances.size, 0);
    const nextOwner = await f.bridge.pool.resolve(f.session);
    assert.notEqual(nextOwner.ownerRecord.generation, first.observation.owner_generation);
    assert.equal((await read()).observation.id, first.observation.id);
    assert.equal((await f.bridge.compact({ session_id: f.id })).status, 'rejected');
    await release();
    assert.equal((await read()).observation.id, first.observation.id);
    await f.bridge.send({ session_id: f.id, text: 'KEPT_TAIL' });
    await release();
    const next = await read();
    assert.notEqual(next.observation.id, first.observation.id);
    assert.match(JSON.stringify(next.items), /KEPT_TAIL/);
  },
);

for (const change of ['newer_capture', 'failed_capture', 'new_owner']) {
  test(`retained publication cannot regress after an older Bridge.read finishes late (${change})`, async (t) => {
    const f = await nativeOwner(t),
      held = Promise.withResolvers(),
      proceed = Promise.withResolvers();
    // Exercise real Bridge acquisition, final identity checks and saved reads.
    // Control only the owner capture and the async identity-recheck boundary.
    const ctx = {
      sessionManager: {
        getSessionFile: () => f.session.file,
        getSessionId: () => f.session.header.id,
        getLeafId: () => null,
        getEntries: () => [],
      },
    };
    let arm = false,
      first = true;
    const observer = new ContextObservation('owner-one');
    observer.capture({ messages: [{ role: 'user', content: 'OLDER_REQUEST' }] }, ctx);
    const owner = (observer, generation) => ({
      attached: true,
      alive: true,
      record: { kind: 'tui', generation },
      async read(args) {
        const snapshot = observer.read(args, ctx);
        if (first) {
          first = false;
          arm = true;
        }
        return snapshot;
      },
      async stop() {
        this.alive = false;
      },
    });
    let runtime = owner(observer, 'owner-one');
    f.bridge.pool.instances.set(f.id, runtime);
    t.mock.method(f.bridge.pool, 'forRead', async () => runtime);
    const session = f.bridge.session.bind(f.bridge);
    t.mock.method(f.bridge, 'session', async (id) => {
      const value = await session(id);
      if (arm) {
        arm = false;
        held.resolve();
        await proceed.promise;
      }
      return value;
    });
    const read = () => f.bridge.read({ session_id: f.id, view: 'runtime' });
    const older = read();
    t.after(() => proceed.resolve());
    await held.promise;
    if (change === 'new_owner') {
      const next = new ContextObservation('owner-two');
      next.capture({ messages: [{ role: 'user', content: 'NEWER_REQUEST' }] }, ctx);
      // Even if the old runtime has not reported exit yet, it is not current.
      runtime = owner(next, 'owner-two');
      f.bridge.pool.instances.set(f.id, runtime);
    } else {
      observer.capture(
        {
          messages:
            change === 'failed_capture' ? null : [{ role: 'user', content: 'NEWER_REQUEST' }],
        },
        ctx,
      );
    }
    const newer = await read();
    assert.equal(newer.observation.available, change !== 'failed_capture');
    assert.ok(!JSON.stringify(newer).includes('capture_sequence'));
    proceed.resolve();
    assert.ok(JSON.stringify(await older).includes('OLDER_REQUEST'));
    await runtime.stop();
    f.bridge.pool.instances.delete(f.id);
    runtime = null;
    const retained = await read();
    assert.equal(retained.source, 'retained');
    assert.equal(retained.observation.available, change !== 'failed_capture');
    if (change === 'failed_capture') {
      assert.equal(newer.observation.reason, 'capture_failed');
      assert.equal(retained.observation.reason, 'no_retained_observation');
      assert.deepEqual(retained.items, []);
    } else {
      assert.ok(JSON.stringify(retained.items).includes('NEWER_REQUEST'));
      assert.equal(retained.observation.id, newer.observation.id);
    }
  });
}
