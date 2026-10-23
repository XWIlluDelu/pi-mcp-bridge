import test from 'node:test';
import assert from 'node:assert/strict';
import { PiRpc, RuntimePool } from '../src/rpc.mjs';
import { RuntimeEvents } from '../src/runtime-events.mjs';
import { prepareContextRead } from '../src/context-read.mjs';
import { ContextReadCache } from '../src/read-cache.mjs';
import { assertContextReadResponse } from './fixtures/read-pages.mjs';
import { toolResultBytes } from '../src/response-budget.mjs';

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const notify = (message) => ({ type: 'extension_ui_request', method: 'notify', message });

test('native errors and notifications belong only to their RPC generation, not pending prompts', async () => {
  const rpc = new PiRpc({}, { id: 's' }),
    writes = [];
  rpc.alive = true;
  rpc.child = { stdin: { write: (line) => writes.push(JSON.parse(line)) } };
  const pending = rpc.dispatch({ type: 'prompt', message: '/synthetic' });
  const generation = rpc.generation;
  const error = {
    type: 'extension_error',
    extensionPath: 'command:synthetic',
    event: 'command',
    error: 'FAILED',
  };
  rpc.receiveResponse(error, 'other-generation');
  rpc.receiveResponse({ ...error, error: null }, generation);
  rpc.receiveResponse({ ...notify('ignored'), method: 'setStatus' }, generation);
  assert.equal(rpc.runtimeEvents.snapshot(4096), null);
  rpc.receiveResponse(error, generation);
  rpc.receiveResponse(notify('before ACK'), generation);
  assert.ok(rpc.promptAdmission);
  rpc.receiveResponse(
    {
      type: 'response',
      command: 'prompt',
      id: writes[0].id,
      success: true,
      data: { disposition: 'handled' },
    },
    generation,
  );
  assert.deepEqual(await pending, { disposition: 'handled' });
  rpc.receiveResponse(notify('after ACK'), generation);
  const snapshot = rpc.runtimeEvents.snapshot(4096);
  assert.equal(snapshot.generation, generation);
  assert.deepEqual(
    snapshot.events.map((e) => e.type),
    ['extension_error', 'notify', 'notify'],
  );
  assert.equal(snapshot.events[0].extension_path, 'command:synthetic');
  for (const event of snapshot.events) {
    assert.equal(event.prompt_id, undefined);
    assert.equal(event.id, undefined);
  }
  const pool = new RuntimePool({});
  pool.watchRuntime(rpc);
  assert.equal(pool.runtimeEvents.get('s'), rpc.runtimeEvents);
  // A replacement generation replaces retained observations; other sessions are bounded.
  const replacement = new PiRpc({}, { id: 's' });
  pool.watchRuntime(replacement);
  assert.equal(pool.runtimeEvents.get('s').snapshot(4096), null);
  for (let i = 0; i < 20; i++) pool.watchRuntime(new PiRpc({}, { id: 's' + i }));
  assert.equal(pool.runtimeEvents.size, 16);
});

test('an observed native identity switch invalidates retained events even after the runtime closes', async () => {
  const session = { id: 's', file: '/synthetic/a.jsonl', header: { id: 'a' } };
  const rpc = new PiRpc({}, session),
    pool = new RuntimePool({});
  pool.watchRuntime(rpc);
  rpc.receiveResponse(notify('unverified session notice'), rpc.generation);
  rpc.dispatch = async () => ({ sessionFile: '/synthetic/b.jsonl', sessionId: 'b' });
  rpc.stop = async () => assert.fail('Identity observation must not stop the process');
  await assert.rejects(rpc.state(), { code: 'RUNTIME_SESSION_CHANGED' });
  rpc.receiveResponse(notify('after switch'), rpc.generation);
  assert.equal(pool.runtimeEvents.get('s').snapshot(4096), null);
});

test('event retention and fresh read previews are bounded; cursor pages stay historical', () => {
  const events = new RuntimeEvents('generation');
  for (let i = 0; i < 40; i++) events.observe(notify('long 😀\u0000'.repeat(1000)));
  assert.equal(events.events.length, 32);
  assert.ok(events.events.every((e) => e.message.length <= 2048));
  const observations = events.snapshot(1024);
  assert.ok(bytes(observations) <= 1024);
  assert.equal(observations.events.at(-1).sequence, 40);
  assert.equal(observations.omitted_events, 40 - observations.events.length);
  assert.ok(observations.events.at(-1).truncated_fields.includes('message'));
  const entry = {
    type: 'message',
    id: 'user',
    parentId: null,
    timestamp: '2026-01-01T00:00:00Z',
    message: { role: 'user', content: 'history\n\n'.repeat(6000), timestamp: 0 },
  };
  const args = { session_id: 's', max_bytes: 24000 },
    prepared = prepareContextRead(
      { header: { id: 'native' }, entries: [entry], leafId: entry.id },
      args,
    ),
    cache = new ContextReadCache(),
    identity = { session_id: 's', file: '/fixture/native.jsonl', native_id: 'native' },
    options = { identity, runtimeEvents: observations };
  const first = cache.render(prepared, args, options);
  assertContextReadResponse(first, args);
  assert.equal(first.runtime_events.generation, 'generation');
  assert.ok(first.next_cursor);
  const continuation = { cursor: first.next_cursor, max_bytes: 4096 },
    captured = cache.get(continuation, identity),
    next = cache.render(captured.snapshot, continuation, { ...captured, identity });
  assertContextReadResponse(next, continuation);
  assert.equal(next.runtime_events, undefined);
  assert.equal(
    cache.render(prepared, { ...args, leaf_id: 'user' }, options).runtime_events,
    undefined,
  );

  const frozen = JSON.stringify(prepared.units),
    reduced = cache.render(prepared, args, {
      ...options,
      resultBudget: { maxBytes: 19000, maxWireBytes: 25000 },
    });
  assertContextReadResponse(reduced, args);
  assert.ok(bytes(reduced) <= 19000);
  assert.ok(toolResultBytes(reduced) <= 25000);
  assert.ok(reduced.items.length > 0, 'Committed history wins over optional previews');
  if (reduced.runtime_events) assert.equal(reduced.runtime_events.events.at(-1).sequence, 40);
  assert.equal(
    JSON.stringify(prepared.units),
    frozen,
    'Batch budgets render the captured snapshot without mutation',
  );
});
