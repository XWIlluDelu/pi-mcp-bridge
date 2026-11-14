import { nativeOwner } from './fixtures/native-owner.mjs';
import { append, message, text } from './fixtures/native-history.mjs';
import { ALL_CONTENT } from '../src/read-schema.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_RESPONSE_LIMIT } from '../src/response-budget.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { callBridgeTool, dispatchModern, META, MODERN_VERSION } from '../src/protocol.mjs';
async function nativeLongPath(dir) {
  let value = dir;
  const segment = '\x01'.repeat(200) + '漢😀\n"\\';
  while (Buffer.byteLength(path.join(value, segment, 'output.log')) < 4000)
    value = path.join(value, segment);
  await fs.mkdir(value, { recursive: true, mode: 0o700 });
  return value;
}

test('ten real deletes keep restore tokens when escaped native project paths cannot fit', async (t) => {
  const f = await nativeOwner(t, {
    prefix: 'batch-delete',
    factory: () => assert.fail('No fallback writer'),
    async configure({ dir, config }) {
      const project = await nativeLongPath(dir);
      config.folders = [{ path: project }];
      config.defaults.delete = true;
      config.grants = [];
    },
  });
  const { bridge } = f;
  const operations = [{ op: 'delete', args: { session_id: f.id } }];
  while (operations.length < 10)
    operations.push({ op: 'delete', args: { session_id: (await f.create()).id } });
  const response = await dispatchModern(bridge, {
    jsonrpc: '2.0',
    id: '\0'.repeat(1024),
    method: 'tools/call',
    params: {
      name: 'batch',
      arguments: { operations },
      _meta: {
        [META + 'protocolVersion']: MODERN_VERSION,
        [META + 'clientCapabilities']: {},
      },
    },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(response.message)) <= MCP_RESPONSE_LIMIT);
  const results = response.message.result.structuredContent.results;
  assert.equal(results.length, 10);
  for (const { result, error } of results) {
    assert.equal(error, undefined);
    assert.equal(result.status, 'deleted');
    assert.equal(result.recoverable, true);
    assert.match(result.restore_token, /^[0-9a-f-]{36}$/);
    assert.equal(result.project, undefined);
  }
  assert.equal(new Set(results.map(({ result }) => result.restore_token)).size, 10);
});

test('batch reads with large shared tool metadata retain complete pageable body and parent pairing', async (t) => {
  const { bridge, session, id } = await nativeOwner(t, {
    prefix: 'batch-read',
    factory: () => assert.fail('Read must not start Pi'),
  });
  const body = 'PAGE_BODY '.repeat(1200);
  await append(session, [
    message('u', null, 'user', 'inspect'),
    message('a', 'u', 'assistant', [
      { type: 'toolCall', id: 'outer', name: 'read', arguments: {} },
    ]),
    message('r', 'a', 'toolResult', [text(body.slice(0, 6000)), text(body.slice(6000))], {
      toolCallId: 'outer',
      toolName: 'read',
      isError: false,
      details: 'D'.repeat(65000),
    }),
  ]);
  const browse = await bridge.read({ session_id: id, range: { recent: -1 }, content: ALL_CONTENT });
  const tool = browse.items.find((item) => item.type === 'tool');
  assert.ok(tool.ref);
  const response = await callBridgeTool(bridge, 'batch', {
    operations: Array.from({ length: 10 }, () => ({
      op: 'read',
      args: { refs: [tool.ref], max_bytes: 65536 },
    })),
  });
  assert.ok(!response.isError, JSON.stringify(response));
  assert.ok(Buffer.byteLength(JSON.stringify(response)) <= MCP_RESPONSE_LIMIT);
  for (const { result, error } of response.structuredContent.results) {
    assert.equal(error, undefined);
    assert.ok(result.next_cursor);
  }
  let page = response.structuredContent.results[0].result;
  const pages = [page];
  while (page.next_cursor) {
    const next = await callBridgeTool(bridge, 'read', {
      cursor: page.next_cursor,
      max_bytes: 4096,
    });
    assert.ok(!next.isError, JSON.stringify(next));
    page = next.structuredContent;
    pages.push(page);
  }
  const units = pages.flatMap((p) => p.items).filter((u) => u.type === 'tool_result');
  assert.equal(
    units
      .flatMap((u) => u.message.content)
      .map((b) => b.text)
      .join(''),
    body,
  );
  assert.ok(units.every((u) => u.source.entry_id === 'r' && u.call_id === 'outer'));
});
