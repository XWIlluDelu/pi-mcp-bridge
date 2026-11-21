import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  dispatchMcp,
  MODERN_VERSION,
  LEGACY_VERSIONS,
  META,
  toolDefinitions,
} from '../src/mcp/protocol.mjs';
import { StdioTransport } from '../src/mcp/protocol-stdio.mjs';
import { createHttpService } from '../src/http-server.mjs';
import { createStdioProxy } from '../src/stdio-proxy.mjs';
import { TOKEN_HEADER } from '../src/mcp/http-config.mjs';
import { readLfLines } from '../src/core/lf-lines.mjs';
import { nativeOwner } from './fixtures/native-owner.mjs';

test('tool definitions stay compact to minimize external-agent token overhead', () => {
  const defs = toolDefinitions();
  assert.equal(defs.length, 13);
  const serialized = JSON.stringify(defs);
  assert.ok(
    serialized.length < 8500,
    `Expected compact tool definitions (<8500 chars), got ${serialized.length}`,
  );
  assert.equal(serialized.includes('additionalProperties'), false);
});

test('unified MCP dispatcher supports both 2026-07-28 and standard initialize clients on HTTP and stdio-proxy', async (t) => {
  const fixture = await nativeOwner(t, { prefix: 'mcp-interop' });
  const { bridge } = fixture;

  const token = 'A'.repeat(40);
  const service = createHttpService(bridge, { token, port: 0 });
  const url = await service.listen();
  t.after(() => service.close());

  const post = async (body, extraHeaders = {}) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        [TOKEN_HEADER]: token,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  // 1) Standard MCP 2025-11-25 handshake (Claude Desktop / Claude Code / Cursor / Pi MCP)
  const init = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'pi-mcp', version: '1.5.2' },
    },
  });
  assert.equal(init.status, 200);
  assert.equal(init.body.result.protocolVersion, '2025-11-25');
  assert.equal(init.body.result.resultType, undefined);
  assert.equal(init.body.result.serverInfo.name, 'pi-session-bridge');

  const notified = await post(
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { 'MCP-Protocol-Version': '2025-11-25' },
  );
  assert.equal(notified.status, 202);
  assert.equal(notified.body, null);

  const legacyTools = await post(
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { 'MCP-Protocol-Version': '2025-11-25' },
  );
  assert.equal(legacyTools.status, 200);
  assert.equal(legacyTools.body.result.tools.length, 13);
  assert.equal(legacyTools.body.result.resultType, undefined);

  const legacyCall = await post(
    {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_sessions', arguments: {} },
    },
    { 'MCP-Protocol-Version': '2025-11-25' },
  );
  assert.equal(legacyCall.status, 200);
  assert.equal(legacyCall.body.result.structuredContent.sessions[0].session_id, fixture.id);

  // Older legacy version negotiation (2024-11-05)
  const older = await dispatchMcp(bridge, {
    jsonrpc: '2.0',
    id: 4,
    method: 'initialize',
    params: { protocolVersion: LEGACY_VERSIONS.at(-1), capabilities: {} },
  });
  assert.equal(older.message.result.protocolVersion, '2024-11-05');

  // 2) Modern 2026-07-28 per-request stateless MCP on the exact same endpoint
  const modernBody = {
    jsonrpc: '2.0',
    id: 'm1',
    method: 'server/discover',
    params: {
      _meta: {
        [META + 'protocolVersion']: MODERN_VERSION,
        [META + 'clientCapabilities']: {},
      },
    },
  };
  const modernRes = await post(modernBody, {
    'MCP-Protocol-Version': MODERN_VERSION,
    'Mcp-Method': 'server/discover',
  });
  assert.equal(modernRes.status, 200);
  assert.equal(modernRes.body.result.resultType, 'complete');
  assert.deepEqual(modernRes.body.result.supportedVersions, [MODERN_VERSION]);

  // 3) Stdio proxy transparently forwards legacy initialize + tools/call
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = [];
  const reader = readLfLines(output, (line) => replies.push(JSON.parse(line)));
  t.after(() => reader.close());
  const proxy = createStdioProxy({ port: Number(new URL(url).port), token, input, output });
  proxy.start();
  t.after(() => proxy.close());

  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 10,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }) + '\n',
  );
  input.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  input.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'health', arguments: {} },
    }) + '\n',
  );
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (replies.length >= 2) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  assert.equal(replies.find((r) => r.id === 10).result.protocolVersion, '2025-11-25');
  assert.equal(replies.find((r) => r.id === 11).result.structuredContent.domain, 'permissions');

  // 4) Direct stdio transport handles both initialize and modern server/discover
  const sIn = new PassThrough();
  const sOut = new PassThrough();
  const sReplies = [];
  const sReader = readLfLines(sOut, (line) => sReplies.push(JSON.parse(line)));
  t.after(() => sReader.close());
  const stdio = new StdioTransport(async (body) => (await dispatchMcp(bridge, body)).message, {
    input: sIn,
    output: sOut,
  });
  stdio.start();
  t.after(() => stdio.close());
  sIn.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 's1',
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {} },
    }) + '\n',
  );
  sIn.write(JSON.stringify({ ...modernBody, id: 's2' }) + '\n');
  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (sReplies.length >= 2) {
        clearInterval(check);
        resolve();
      }
    }, 10);
  });
  assert.equal(sReplies.find((r) => r.id === 's1').result.protocolVersion, '2025-11-25');
  assert.equal(sReplies.find((r) => r.id === 's2').result.resultType, 'complete');
});
