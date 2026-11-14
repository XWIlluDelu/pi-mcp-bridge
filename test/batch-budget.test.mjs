import { ALL_CONTENT } from '../src/read-schema.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_RESPONSE_LIMIT } from '../src/response-budget.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';

import { savedSession } from './fixtures/saved-session.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
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
  const dir = await fs.mkdtemp('/tmp/pi-batch-delete-budget-'),
    project = await nativeLongPath(dir);
  const bridge = await new Bridge(
    {
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: project }],
      defaults: { ...denyAllPermissions(), delete: true },
    },
    () => assert.fail('No fallback writer'),
  ).init();
  try {
    const operations = [];
    for (let i = 0; i < 10; i++)
      operations.push({
        op: 'delete',
        args: { session_id: (await savedSession(bridge)).session_id },
      });
    const remove = t.mock.method(bridge, 'delete', bridge.delete.bind(bridge));
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
    assert.equal(remove.mock.calls.length, 10);
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
  } finally {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('batch reads with large shared tool metadata retain complete pageable body and parent pairing', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-batch-read-metadata-'),
    project = path.join(dir, 'project');
  await fs.mkdir(project);
  const bridge = await new Bridge(
    {
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: project }],
      defaults: { ...denyAllPermissions(), read: true },
    },
    () => assert.fail('No read writer'),
  ).init();
  t.after(async () => {
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const made = await savedSession(bridge),
    session = await bridge.session(made.session_id),
    body = 'PAGE_BODY '.repeat(1200);
  await fs.appendFile(
    session.file,
    [
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'inspect' } },
      {
        type: 'message',
        id: 'a',
        parentId: 'u',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'outer', name: 'read', arguments: {} }],
        },
      },
      {
        type: 'message',
        id: 'r',
        parentId: 'a',
        message: {
          role: 'toolResult',
          toolCallId: 'outer',
          toolName: 'read',
          isError: false,
          content: [
            { type: 'text', text: body.slice(0, 6000) },
            { type: 'text', text: body.slice(6000) },
          ],
          details: 'D'.repeat(65000),
        },
      },
    ]
      .map(JSON.stringify)
      .join('\n') + '\n',
  );
  const browse = await bridge.read({
    session_id: made.session_id,
    range: { recent: -1 },
    content: ALL_CONTENT,
  });
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
    assert.ok(
      result.items.some((u) => u.type === 'tool_result' && u.message.content.some((b) => b.text)),
    );
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
