import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { nativeOwner, nativeTui } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

test('a native permission menu edit changes the next MCP read decision', async (t) => {
  const f = await nativeOwner(t, { prefix: 'menu' });
  const extension = new URL('../src/owner-permissions-extension.mjs', import.meta.url).pathname;
  const tui = await nativeTui(f, f.session, ['-e', extension]);
  const client = new Client({ name: 'owner-menu-fixture', version: '1' });
  f.cleanup.unshift(() => client.close());
  await f.bridge.close();
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [new URL('../src/server.mjs', import.meta.url).pathname, f.configFile],
      env: f.env,
    }),
  );
  const read = () => client.callTool({ name: 'read', arguments: { session_id: f.id } });
  assert.equal(Boolean((await read()).isError), false);

  tui.type('\x1b\x10');
  await tui.waitFor('MCP permissions');
  tui.type('\r');
  await tui.waitFor('Read:');
  tui.type('\x1b[B');
  await pause(35);
  tui.type('\r');
  await tui.waitFor('Inherit');
  tui.type('\x1b[B');
  await pause(35);
  tui.type('\r');
  await until(
    async () =>
      JSON.parse(await fs.readFile(f.configFile, 'utf8')).grants.some(
        (rule) => rule.session_id === f.id && rule.read === false,
      ),
    'session read denied',
  );
  assert.equal((await read()).isError, true);
});
