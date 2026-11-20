import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function fixture(t) {
  const finish = (dir, run) => fs.writeFile(path.join(dir, 'finish-live-stream-' + run), 'go');
  const f = await nativeOwner(t, {
    prefix: 'native-live',
    configure({ config, dir, cleanup }) {
      config.piArgs.push(
        ...fauxArgs,
        '-e',
        path.resolve('test/fixtures/live-stream-gate.mjs'),
        '--thinking',
        'off',
      );
      cleanup.push(() => Promise.all([finish(dir, 1), finish(dir, 2)]));
    },
  });
  return { ...f, finish: (run) => finish(f.dir, run) };
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
    assert.deepEqual(busy.capabilities, { send: true, reload: true, command: true, stop: true });
    assert.equal(live.live.source, 'rpc_message_events');
    assert.equal(live.live.transient, true);
    assert.ok(!live.items.some((item) => item.type === 'assistant'));
    assert.ok(Buffer.byteLength(JSON.stringify(live)) <= 4096);
    const historical = await bridge.read({
      session_id: session.id,
      leaf_id: live.leaf_id,
      max_bytes: 4096,
    });
    assert.equal(historical.live, null);
    await finish(1);
    await until(() => !bridge.pool.get(session.id) && !bridge.lane(session.id));
    assert.equal((await status()).state, 'saved');
    assert.equal(Object.hasOwn(await status(), 'capabilities'), false);
    const final = await bridge.read({ session_id: session.id, max_bytes: 4096 });
    assert.equal(final.live.available, false);
    assert.equal(final.live.reason, 'native_events_unavailable');
    assert.ok(final.items.some((item) => item.type === 'assistant'));
    const fixed = await bridge.read({
      session_id: session.id,
      leaf_id: live.leaf_id,
      max_bytes: 4096,
    });
    assert.deepEqual(
      fixed.items.map(({ ref, ...item }) => item),
      historical.items.map(({ ref, ...item }) => item),
    );
    assert.equal(fixed.leaf_id, historical.leaf_id);
  },
);

test(
  'a captured native projection keeps its matching preview when a later prompt runs',
  { timeout: 15000 },
  async (t) => {
    const { bridge, session, finish } = await fixture(t);
    const read = () => bridge.read({ session_id: session.id, max_bytes: 4096 });
    const preview = async () => {
      const result = await read();
      return result.live?.items?.some((u) => u.block?.text) ? result : null;
    };
    await bridge.send({ session_id: session.id, text: 'PROMPT_A' });
    await until(preview);
    const rpc = bridge.pool.get(session.id),
      observing = rpc.observeRead.bind(rpc),
      captured = Promise.withResolvers(),
      resume = Promise.withResolvers();
    let holding = false,
      first;
    t.after(() => resume.resolve());
    t.mock.method(rpc, 'observeRead', (work) =>
      observing(async () => {
        const result = await work();
        if (!holding) {
          holding = true;
          first = structuredClone(result);
          captured.resolve();
          await resume.promise;
        }
        return result;
      }),
    );
    const reading = read();
    await captured.promise;
    await finish(1);
    await until(() => rpc.settlementSequence > 0);
    await bridge.send({ session_id: session.id, text: 'PROMPT_B' });
    const current = await until(preview);
    resume.resolve();
    const earlier = await reading;
    const oldPrompt = earlier.items.findLast((i) => i.type === 'input'),
      newPrompt = current.items.findLast((i) => i.type === 'input');
    assert.equal(oldPrompt.text, 'PROMPT_A');
    assert.deepEqual(earlier.live, first.live);
    assert.equal(earlier.live.prompt_id, oldPrompt.source.entry_id);
    assert.equal(newPrompt.text, 'PROMPT_B');
    assert.equal(current.live.prompt_id, newPrompt.source.entry_id);
    assert.notEqual(current.live.prompt_id, earlier.live.prompt_id);
  },
);
