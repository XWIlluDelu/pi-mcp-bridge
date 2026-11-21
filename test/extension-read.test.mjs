import { nativeOwner } from './fixtures/native-owner.mjs';
import { readSource } from './fixtures/read-source.mjs';
import { ALL_CONTENT } from '../src/read/read-schema.mjs';

import { test } from 'node:test';

import assert from 'node:assert/strict';

import { offlineModels, sdkSession } from './fixtures/native-sdk.mjs';
import {
  fauxAssistantMessage,
  fauxToolCall,
  fauxProvider,
  SessionManager,
} from './fixtures/pi.mjs';
import { loadSavedSession } from '../src/core/data.mjs';

async function sdk(t, f, factory, expectedCalls = 0, tools = []) {
  const manager = SessionManager.open(f.session.file),
    old = manager.appendMessage({ role: 'user', content: 'PUBLIC_OLD', timestamp: 1 });
  manager.appendMessage(fauxAssistantMessage('PUBLIC_PRIOR_REPLY'));
  const kept = manager.appendMessage({ role: 'user', content: 'PUBLIC_KEPT', timestamp: 2 });
  const faux = fauxProvider({ provider: 'read-fixture' });
  const session = await sdkSession(f, await offlineModels(faux), faux.getModel(), {
    manager,
    tools,
    settings: { compaction: { enabled: false, keepRecentTokens: 1 } },
    extensions: [(pi) => factory(pi, { old, kept })],
  });
  const errors = [];
  await session.bindExtensions({ mode: 'rpc', onError: (e) => errors.push(e) });
  t.after(() => {
    session.dispose();
    assert.deepEqual(errors, []);
    assert.equal(
      faux.state.callCount,
      expectedCalls,
      'Only explicitly scripted offline provider calls may occur',
    );
  });
  return { session, manager, old, kept, faux };
}

test('original custom compaction hook preserves native summary, retained boundary and raw provenance', async (t) => {
  const f = await nativeOwner(t);
  let compactCalls = 0;
  const { session, manager, kept, old } = await sdk(t, f, (pi, ids) =>
    pi.on('session_before_compact', (event) => {
      compactCalls++;
      return {
        compaction: {
          summary: 'PUBLIC_EXTENSION_CHECKPOINT',
          firstKeptEntryId: ids.kept,
          tokensBefore: event.preparation.tokensBefore,
          details: { fixture: true },
        },
      };
    }),
  );
  await session.compact();
  assert.equal(compactCalls, 1);
  const entry = manager.getEntries().find((e) => e.type === 'compaction');
  assert.equal(entry.fromHook, true);
  const context = await readSource(f.bridge, { session_id: f.id, range: { recent: 3 } });
  const parts = context.items.find((x) => x.type === 'summary').parts;
  assert.equal(parts[0].source.entry_id, entry.id);
  assert.equal(parts[0].message.summary, 'PUBLIC_EXTENSION_CHECKPOINT');
  assert.ok(JSON.stringify(context).includes('PUBLIC_KEPT'));
  assert.ok(!JSON.stringify(context).includes('PUBLIC_OLD'));
  const raw = await loadSavedSession(f.session);
  assert.equal(raw.entries.find((x) => x.id === entry.id).firstKeptEntryId, kept);
  assert.equal(raw.entries.find((x) => x.id === entry.id).fromHook, true);
  assert.ok(raw.entries.some((x) => x.id === old));
  assert.equal(compactCalls, 1, 'Reads do not rerun compaction hooks');
});

test('real nested tool failure remains visible under its successful outer tool in a read-only native projection', async (t) => {
  const f = await nativeOwner(t);
  const { session, faux, manager } = await sdk(
    t,
    f,
    (pi) => {
      pi.registerTool({
        name: 'inner_failure',
        exposure: 'deferred',
        label: 'Inner',
        description: 'Native nested failure',
        parameters: { type: 'object', properties: {} },
        async execute() {
          throw new Error('NESTED_REAL_FAILURE');
        },
      });
      pi.registerTool({
        name: 'outer_success',
        label: 'Outer',
        description: 'Native outer success',
        parameters: { type: 'object', properties: {} },
        async execute(_id, _params, _signal, _update, ctx) {
          const result = await ctx.executeTool('inner_failure', {});
          assert.equal(result.isError, true);
          return { content: [{ type: 'text', text: 'OUTER_SUCCESS' }], details: {} };
        },
      });
      pi.on('session_start', () => pi.setActiveTools(['outer_success']));
    },
    2,
    ['outer_success', 'inner_failure'],
  );
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('outer_success', {})], { stopReason: 'toolUse' }),
    fauxAssistantMessage('NESTED_FINISHED'),
  ]);
  await session.prompt('RUN_NESTED');
  const raw = manager.getEntries().find((e) => e.message?.role === 'toolResult').message;
  assert.equal(raw.isError, false, JSON.stringify(raw));
  assert.equal(raw.nestedCalls.calls[0].status, 'error');
  assert.match(raw.nestedCalls.calls[0].error, /NESTED_REAL_FAILURE/);
  const read = await readSource(f.bridge, {
    session_id: f.id,
    range: { recent: -1 },
    content: ALL_CONTENT,
  });
  const outer = read.items.find((u) => u.type === 'tool_result').message;
  assert.equal(outer.isError, false);
  assert.deepEqual(outer.nestedCalls, raw.nestedCalls);
});
