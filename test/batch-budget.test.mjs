import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MCP_RESPONSE_LIMIT } from '../src/response-budget.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Bridge } from '../src/bridge.mjs';
import { reserveHostSession } from '../src/host-adapter.mjs';
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

for (const [op, longMetadata] of [
  ['command', false],
  ['stop', false],
  ['command', true],
])
  test(
    'ten real Bridge ' +
      op +
      (longMetadata ? ' with long native paths' : '') +
      ' captures keep every result within the complete MCP wire budget',
    async (t) => {
      const dir = await fs.mkdtemp('/tmp/pi-batch-budget-'),
        project = path.join(dir, 'project');
      await fs.mkdir(project, { mode: 0o700 });
      const config = {
        stateDir: path.join(dir, 'state'),
        sessionRoots: [path.join(dir, 'sessions')],
        folders: [{ path: project }],
        defaults: { ...denyAllPermissions(), [op]: true },
      };
      const bridge = await new Bridge(config, () => assert.fail('No fallback writer')).init();
      let owner;
      try {
        const made = await savedSession(bridge),
          session = await bridge.session(made.session_id);
        const output = longMetadata ? 'small native output' : '漢😀"\\\n'.repeat(20000);
        const fullOutputPath = longMetadata
          ? path.join(await nativeLongPath(dir), 'output.log')
          : null;
        if (fullOutputPath) await fs.writeFile(fullOutputPath, output, { mode: 0o600 });
        let calls = 0;
        owner = await reserveHostSession({ attachmentDir: bridge.pool.attachmentDir, session });
        await owner.ready({
          state: async () => ({ sessionFile: session.file, sessionId: session.header.id }),
          snapshot: async () => ({
            sessionFile: session.file,
            sessionId: session.header.id,
            entries: [],
            leafId: null,
          }),
          submit: async () => assert.fail('No prompt'),
          bash: async ({ onResult }) => {
            calls++;
            await onResult({
              output,
              exitCode: 0,
              cancelled: false,
              truncated: false,
              fullOutputPath,
            });
            return { output, exitCode: 0, cancelled: false, truncated: false, fullOutputPath };
          },
          stop: async ({ onWithdraw }) => {
            if (op === 'stop') calls++;
            await onWithdraw({ text: output, includesEditorDraft: true });
            return {
              status: 'accepted',
              acknowledgement: 'native_ack',
              coverage: 'agent_and_bash',
            };
          },
        });
        const operations = Array.from({ length: 10 }, () => ({
          op,
          args: {
            session_id: session.id,
            max_chars: 32768,
            ...(op === 'command' ? { command: 'synthetic native capture' } : {}),
          },
        }));
        const response = await dispatchModern(bridge, {
          jsonrpc: '2.0',
          id: '\u0000'.repeat(1024),
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
        assert.equal(calls, 10);
        assert.ok(Buffer.byteLength(JSON.stringify(response.message)) <= MCP_RESPONSE_LIMIT);
        const result = response.message.result.structuredContent;
        assert.equal(result.results.length, 10);
        for (const item of result.results) {
          assert.equal(item.error, undefined, JSON.stringify(item));
          assert.equal(item.result.status, 'accepted');
          const text = item.result[op === 'command' ? 'output' : 'withdrawn_text'];
          assert.ok(text.length > 0);
          assert.ok(text.isWellFormed());
          assert.ok(output.startsWith(text));
          assert.equal(
            item.result[op === 'command' ? 'response_complete' : 'withdrawn_complete'],
            text.length === output.length,
          );
          if (op === 'stop') assert.equal(item.result.includes_editor_draft, true);
          if (longMetadata) {
            assert.equal(item.result.fullOutputPath, undefined);
            assert.equal(item.result.output, output);
          }
        }
      } finally {
        await owner?.close();
        await bridge.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );

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

test('captured list pages keep creation targets and offsets; an unpageable title cannot displace deletion', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-batch-list-budget-'),
    project = path.join(dir, 'project');
  await fs.mkdir(project, { mode: 0o700 });
  const bridge = await new Bridge(
    {
      stateDir: path.join(dir, 'state'),
      sessionRoots: [path.join(dir, 'sessions')],
      folders: [{ path: project }, { path: path.join(dir, 'empty-project') }],
      defaults: { ...denyAllPermissions(), list: true, create: true, delete: true },
    },
    () => assert.fail('No fallback writer'),
  ).init();
  try {
    const saved = [];
    for (let i = 0; i < 10; i++) {
      const made = await savedSession(bridge),
        session = await bridge.session(made.session_id);
      await fs.appendFile(
        session.file,
        JSON.stringify({
          type: 'session_info',
          id: 'title',
          parentId: null,
          name: '漢😀"\\\n'.repeat(400),
        }) + '\n',
      );
      saved.push(session);
    }
    const lists = t.mock.method(bridge, 'list', bridge.list.bind(bridge));
    const response = await callBridgeTool(bridge, 'batch', {
      operations: Array.from({ length: 10 }, () => ({ op: 'list', args: { limit: 10 } })),
    });
    assert.ok(!response.isError);
    assert.equal(lists.mock.calls.length, 10);
    for (const [index, { result }] of response.structuredContent.results.entries()) {
      const captured = await lists.mock.calls[index].result;
      assert.ok(result.sessions.length > 0 && result.sessions.length < 10);
      assert.deepEqual(result.sessions, captured.sessions.slice(0, result.sessions.length));
      assert.equal(result.next_offset, result.sessions.length);
      assert.deepEqual(result.creatable_projects, [project, path.join(dir, 'empty-project')]);
    }
    const target = saved[0];
    await fs.appendFile(
      target.file,
      JSON.stringify({
        type: 'session_info',
        id: 'huge-title',
        parentId: 'title',
        name: '漢😀"\\\n'.repeat(20000),
      }) + '\n',
    );
    const refused = await callBridgeTool(bridge, 'batch', {
      operations: [
        ...Array.from({ length: 9 }, () => ({ op: 'list', args: { session_id: target.id } })),
        { op: 'delete', args: { session_id: target.id } },
      ],
    });
    assert.ok(!refused.isError);
    for (const { error } of refused.structuredContent.results.slice(0, 9))
      assert.equal(error.code, 'BATCH_QUERY_BUDGET_TOO_SMALL');
    const removed = refused.structuredContent.results.at(-1).result;
    assert.equal(removed.status, 'deleted');
    assert.match(removed.restore_token, /^[0-9a-f-]{36}$/);
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
  const response = await callBridgeTool(bridge, 'batch', {
    operations: Array.from({ length: 10 }, () => ({
      op: 'read',
      args: { session_id: made.session_id, detail: 'full', preset: 'full', max_bytes: 65536 },
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
  const units = pages
    .reverse()
    .flatMap((p) => p.items)
    .filter((u) => u.type === 'tool_result');
  assert.equal(
    units
      .flatMap((u) => u.message.content)
      .map((b) => b.text)
      .join(''),
    body,
  );
  assert.ok(units.every((u) => u.source.entry_id === 'r' && u.call_id === 'outer'));
});
