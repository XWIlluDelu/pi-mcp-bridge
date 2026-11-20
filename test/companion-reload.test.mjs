import packageInfo from '../package.json' with { type: 'json' };
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { nativeRpc } from './fixtures/native-rpc.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';
import { launchProfile } from '../src/runtime/rpc.mjs';
import { gatedExtension } from './fixtures/native-owner.mjs';
import { readClaim } from '../src/runtime/attachments.mjs';

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
test(
  'companion reload preserves history, refuses input preparation, fences new work and confirms fresh registration',
  { timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, session } = f;
    await gatedExtension(
      f,
      `
      pi.on('session_shutdown', async ({ reason }) => {
        if (reason !== 'reload') return;
        await mark('reload-start');
        await wait('reload-release');
      });
    `,
    );
    f.cleanup.unshift(async () => {
      await fs.writeFile(f.gate + '.preflight-release', 'go');
      await f.mark('reload-release');
    });
    const client = await nativeRpc(f, {
      env: {
        ...launchProfile(f.config).env,
        HOME: f.dir,
        PI_OFFLINE: '1',
        PI_MCP_ATTACH_DIR: f.bridge.pool.attachmentDir,
      },
      args: [
        '--session',
        session.file,
        ...f.config.piArgs,
        '-e',
        new URL('../src/attach-extension.mjs', import.meta.url).pathname,
      ],
    });
    await client.getState();
    const claim = () => readClaim(f.config.attachmentDir, session);
    const initial = await claim();
    await client.prompt('PRESERVE_BEFORE_RELOAD');
    await until(async () => !(await client.getState()).isStreaming);
    const before = (await client.getEntries()).entries;
    const preflight = client.prompt('HOLD_PREFLIGHT');
    await until(() => exists(f.gate + '.preflight-start'));
    assert.equal(
      (
        await bridge.send({
          session_id: f.id,
          text: 'MUST_NOT_ENTER_DURING_PREFLIGHT',
          mode: 'idle_only',
        })
      ).reason,
      'busy',
    );
    const reload = () => bridge.reload({ session_id: f.id });
    assert.equal((await reload()).reason, 'RELOAD_BUSY');
    assert.equal(await exists(f.dir + '/reload-start'), false);
    await fs.writeFile(f.gate + '.preflight-release', 'go');
    await preflight;
    const reloading = reload();
    await until(() => exists(f.dir + '/reload-start'));
    await assert.rejects(client.prompt('MUST_NOT_ENTER_DURING_RELOAD'), /RELOAD_IN_PROGRESS/);
    await f.mark('reload-release');
    assert.deepEqual(await reloading, {
      status: 'completed',
      owner_version: packageInfo.version,
      read_compatible: true,
    });
    const after = await claim();
    assert.notEqual(after.generation, initial.generation);
    assert.equal(after.owner.pid, initial.owner.pid);
    assert.deepEqual((await client.getEntries()).entries, before);
    await client.prompt('CONTINUE_AFTER_RELOAD');
    await until(async () => !(await client.getState()).isStreaming);
    assert.ok(
      JSON.stringify((await client.getEntries()).entries).includes('CONTINUE_AFTER_RELOAD'),
    );
  },
);
