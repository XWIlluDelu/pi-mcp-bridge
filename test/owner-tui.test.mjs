import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { launchStdio } from './fixtures/stdio-client.mjs';
import { nativeOwner, nativeTui } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';

test('a native permission menu edit changes the next MCP read decision', async (t) => {
  const f = await nativeOwner(t, { prefix: 'menu' });
  const extension = new URL('../src/owner-permissions-extension.mjs', import.meta.url).pathname;
  const tui = await nativeTui(f, f.session, ['-e', extension]);
  await f.bridge.close();
  const client = launchStdio(f);
  const read = () => client.call('read', { session_id: f.id });
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
