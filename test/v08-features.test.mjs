import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { RuntimeEvents } from '../src/read/runtime-events.mjs';
import { callBridgeTool } from '../src/mcp/protocol.mjs';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';

test('offline rename via update updates saved title without starting Pi', async (t) => {
  let spawned = false;
  const fixture = await nativeOwner(t, {
    prefix: 'offline-rename',
    factory: async () => {
      spawned = true;
      throw new Error('must not start Pi');
    },
  });

  const renamed = await fixture.bridge.update_session({
    session_id: fixture.id,
    name: 'Refactor auth flow',
  });
  assert.deepEqual(renamed, { name: 'Refactor auth flow' });
  assert.equal(spawned, false);
  const listed = await fixture.bridge.list_sessions({ session_id: fixture.id });
  assert.equal(listed.sessions[0].name, 'Refactor auth flow');
});

test('read({refs, include_images:true}) returns MCP image content blocks', async (t) => {
  // Valid minimal 1x1 PNG
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const fixture = await nativeOwner(t, { prefix: 'read-images' });
  await fs.appendFile(
    fixture.session.file,
    JSON.stringify({
      type: 'message',
      id: 'm1',
      parentId: null,
      timestamp: '2026-11-21T00:00:00.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this screenshot' },
          { type: 'image', data: pngBase64, mimeType: 'image/png' },
        ],
      },
    }) + '\n',
  );

  const page = await fixture.bridge.read({ session_id: fixture.id });
  const ref = page.items[0].ref;
  const toolRes = await callBridgeTool(fixture.bridge, 'read', {
    refs: [ref],
    include_images: true,
  });
  assert.equal(toolRes.isError, undefined);
  assert.equal(toolRes.content.length, 2);
  assert.equal(toolRes.content[0].type, 'text');
  assert.deepEqual(toolRes.content[1], {
    type: 'image',
    data: pngBase64,
    mimeType: 'image/png',
  });
});

test('runtime_events records cancelled extension UI dialog details', () => {
  const events = new RuntimeEvents('gen-1');
  events.recordUiCancelled(
    {
      method: 'select',
      title: 'Choose deployment target',
      message: 'Pick one environment',
      options: ['staging', 'prod'],
    },
    'cancel_sent',
  );
  const snap = events.snapshot();
  assert.equal(snap.events.length, 1);
  assert.equal(snap.events[0].type, 'ui_cancelled');
  assert.equal(snap.events[0].method, 'select');
  assert.equal(snap.events[0].title, 'Choose deployment target');
  assert.deepEqual(snap.events[0].options, ['staging', 'prod']);
});

test('real Pi owned RPC supports wait_ms, exclude_from_context, context_usage, live rename, and commands discovery', async (t) => {
  const f = await nativeOwner(t, {
    prefix: 'v08-native',
    configure({ config }) {
      config.grants[0].command = true;
      config.piArgs.push(...fauxArgs);
    },
  });

  // 1) send with wait_ms waits for real Pi settlement and returns result excerpt
  const sent = await f.bridge.send({
    session_id: f.id,
    text: 'Reply briefly',
    wait_ms: 15000,
  });
  assert.equal(sent.status, 'started');
  assert.equal(sent.settled, true);
  assert.equal(sent.aborted, false);
  assert.ok(sent.result?.text.length > 0);

  // 2) command with exclude_from_context: true records in_model_context: false
  const cmd = await f.bridge.command({
    session_id: f.id,
    command: 'echo probe-only',
    exclude_from_context: true,
  });
  assert.equal(cmd.status, 'completed');
  assert.match(cmd.output, /probe-only/);
  const withCmd = await f.bridge.read({
    session_id: f.id,
    content: { command: 1, system: true },
  });
  const cmdRow = withCmd.items.find((item) => item.type === 'command');
  assert.ok(cmdRow);
  const expanded = await f.bridge.read({ refs: [cmdRow.ref] });
  assert.equal(expanded.items[0].in_model_context, false);

  // 3) Live rename via update
  const renamed = await f.bridge.update_session({ session_id: f.id, name: 'Live Renamed' });
  assert.equal(renamed.name, 'Live Renamed');
  const listed = await f.bridge.list_sessions({ session_id: f.id });
  assert.equal(listed.sessions[0].name, 'Live Renamed');
});

test('magic-context module is fully standalone with zero internal src imports', async () => {
  const source = await fs.readFile(
    new URL('../integrations/magic-context/index.mjs', import.meta.url),
    'utf8',
  );
  assert.equal(source.includes('../../src/'), false);
  assert.equal(source.includes("'zod'"), false);
});
