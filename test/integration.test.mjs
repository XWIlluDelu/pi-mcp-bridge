import packageInfo from '../package.json' with { type: 'json' };
import { denyAllPermissions } from './fixtures/permissions.mjs';

import { test } from 'node:test';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const base = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
async function configFixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-mcp-integration-'));
  const cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const config = {
    ...isolatedRuntime(dir),
    defaults: denyAllPermissions(),
    stateDir: path.join(dir, 'state'),
    sessionRoots: [path.join(dir, 'sessions')],
    folders: [{ path: cwd }],
    grants: [{ folder: cwd, list: true, read: true, send: true, delete: true, create: true }],
  };
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { config, dir, cwd };
}

test('standard MCP stdio client initializes and calls both single and batch tools', async (t) => {
  const f = await configFixture(t);
  f.config.grants[0].send = false;
  f.config.piArgs.push(
    '-e',
    path.join(base, 'test/fixtures/faux-extension.mjs'),
    '--provider',
    'bridge-fixture',
    '--model',
    'deterministic',
  );
  const filename = path.join(f.dir, 'owner-config.json');
  await fs.writeFile(filename, JSON.stringify(f.config), { mode: 0o600 });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(base, 'src/server.mjs'), filename],
    cwd: base,
    env: { PATH: process.env.PATH, HOME: f.dir, PI_OFFLINE: '1' },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'bridge-protocol-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().version, packageInfo.version);
    assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [
      'batch',
      'command',
      'compact',
      'create',
      'delete',
      'health',
      'list',
      'models',
      'read',
      'reload',
      'search',
      'send',
      'set_model',
      'stop',
      'submission',
    ]);
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
    const sent = await call('send', {
      session_id: made.session_id,
      text: 'hello',
    });
    assert.equal(sent.status, 'rejected');
    assert.equal((await call('delete', { session_id: made.session_id })).status, 'deleted');
  } finally {
    await client.close();
  }
});
