import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RpcClient } from './fixtures/pi.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { launchProfile } from '../src/rpc.mjs';
import { readClaim } from '../src/attachments.mjs';
import { READ_CONTRACT } from '../src/context-read.mjs';

const exists = (file) =>
  fs.stat(file).then(
    () => true,
    () => false,
  );
test(
  'companion reload preserves history, refuses input preparation, fences new work and confirms fresh registration',
  { timeout: 30000 },
  async (t) => {
    const cleanup = [],
      f = await fixture({ after: (fn) => cleanup.push(fn) }),
      session = await f.bridge.session(f.id);
    const extension = path.join(f.dir, 'reload-marker.mjs');
    await fs.writeFile(
      extension,
      `import fs from 'node:fs/promises';
export default function(pi){
  pi.on('session_start', async () => { await fs.appendFile(${JSON.stringify(f.gate + '.loads')}, 'loaded\\n'); });
  pi.on('session_shutdown', async event => {
    if(event.reason!=='reload') return;
    await fs.writeFile(${JSON.stringify(f.gate + '.reload-start')}, 'started');
    while(!await fs.stat(${JSON.stringify(f.gate + '.reload-release')}).then(()=>true,()=>false)) await new Promise(r=>setTimeout(r,10));
  });
}`,
    );
    const client = new RpcClient({
      cliPath: nativePiCli,
      cwd: f.cwd,
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
        path.resolve('src/attach-extension.mjs'),
        '-e',
        extension,
      ],
    });
    t.after(async () => {
      await fs.writeFile(f.gate + '.preflight-release', 'go');
      await fs.writeFile(f.gate + '.reload-release', 'go');
      await client.stop();
      for (const close of cleanup) await close();
    });
    await client.start();
    await client.getState();
    const initial = await readClaim(f.bridge.pool.attachmentDir, session);
    assert.equal(initial.reloadSupported, true);
    await client.prompt('PRESERVE_BEFORE_RELOAD');
    await until(async () => !(await client.getState()).isStreaming);
    const before = (await client.getEntries()).entries;
    const preflight = client.prompt('HOLD_PREFLIGHT');
    await until(() => exists(f.gate + '.preflight-start'));
    const skipped = await f.bridge.send({
      session_id: f.id,
      text: 'MUST_NOT_ENTER_DURING_PREFLIGHT',
      mode: 'idle_only',
    });
    assert.equal(skipped.status, 'skipped');
    assert.equal(skipped.reason, 'busy');
    assert.deepEqual((await client.getEntries()).entries, before);
    const refused = await f.bridge.reload({ session_id: f.id });
    assert.equal(refused.status, 'rejected');
    assert.equal(refused.reason, 'RELOAD_BUSY');
    assert.equal(await exists(f.gate + '.reload-start'), false);
    await fs.writeFile(f.gate + '.preflight-release', 'go');
    await preflight;
    const reloading = f.bridge.reload({ session_id: f.id });
    await until(() => exists(f.gate + '.reload-start'));
    await assert.rejects(client.prompt('MUST_NOT_ENTER_DURING_RELOAD'), /RELOAD_IN_PROGRESS/);
    await fs.writeFile(f.gate + '.reload-release', 'go');
    assert.deepEqual(await reloading, {
      status: 'completed',
      owner_version: READ_CONTRACT,
      read_compatible: true,
    });
    const after = await readClaim(f.bridge.pool.attachmentDir, session);
    assert.notEqual(after.generation, initial.generation);
    assert.equal(after.owner.pid, initial.owner.pid);
    assert.deepEqual((await client.getEntries()).entries, before);
    assert.equal((await fs.readFile(f.gate + '.loads', 'utf8')).trim().split('\n').length, 2);
    assert.ok(!(await f.bridge.read({ session_id: f.id })).error);
    await client.prompt('CONTINUE_AFTER_RELOAD');
    await until(async () => !(await client.getState()).isStreaming);
    assert.ok(
      JSON.stringify((await client.getEntries()).entries).includes('CONTINUE_AFTER_RELOAD'),
    );
  },
);
