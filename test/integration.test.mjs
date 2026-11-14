import packageInfo from '../package.json' with { type: 'json' };
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { toolDefinitions } from '../src/protocol.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standard MCP stdio client initializes and calls both single and batch tools', async (t) => {
  const f = await nativeOwner(t, {
    prefix: 'sdk-stdio',
    seed: false,
    configure({ config }) {
      config.grants[0].send = false;
      config.piArgs.push(...fauxArgs);
    },
  });
  await f.bridge.close();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../src/server.mjs', import.meta.url).pathname, f.configFile],
    env: f.env,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, packageInfo.version);
    const names = (tools) => tools.map((tool) => tool.name).sort();
    assert.deepEqual(names((await client.listTools()).tools), names(toolDefinitions()));
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError);
      return result.structuredContent;
    };
    const made = await call('create', {
      project: f.cwd,
      text: 'initial fixture',
    });
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    const { results } = await call('batch', {
      operations: [
        { op: 'list', args: {} },
        { op: 'read', args: { session_id: made.session_id } },
      ],
    });
    assert.equal(results[0].result.sessions[0].session_id, made.session_id);
    assert.equal(results[1].result.session_id, made.session_id);
  } finally {
    await client.close();
  }
});
