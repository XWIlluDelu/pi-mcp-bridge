import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Bridge } from '../src/bridge.mjs';
import { isolatedRuntime } from './fixtures/isolated-runtime.mjs';
import { denyAllPermissions } from './fixtures/permissions.mjs';
import { savedSession } from './fixtures/saved-session.mjs';
import { assertContextReadResponse } from './fixtures/read-pages.mjs';

async function until(fn) {
  for (let i = 0; i < 500; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw new Error('NATIVE_EVENT_TEST_TIMEOUT');
}
async function fixture(t) {
  const dir = await fs.mkdtemp('/tmp/pi-native-events-'),
    cwd = path.join(dir, 'project');
  await fs.mkdir(cwd);
  const extension = path.join(dir, 'events.mjs');
  await fs.writeFile(
    extension,
    `
    import fs from 'node:fs/promises';
    const dir=${JSON.stringify(dir)}, delay=ms=>new Promise(r=>setTimeout(r,ms));
    async function wait(name){while(!await fs.stat(dir+'/'+name).then(()=>true,()=>false))await delay(10);}
    export default pi=>{
      globalThis.fetch=async()=>{throw new Error('fixture blocks network');};
      pi.registerCommand('audit-fail',{handler:async()=>{throw new Error('AUDIT_NATIVE_COMMAND_FAILED');}});
      pi.registerCommand('audit-deferred',{handler:async(_args,ctx)=>{void wait('notice-go').then(()=>ctx.ui.notify('UNRELATED_ASYNC_NOTICE','warning'));}});
      pi.on('input',async(event,ctx)=>{
        if(event.text==='HELD'){await fs.writeFile(dir+'/held','yes');await wait('input-go');}
        ctx.ui.notify('INPUT_NOTICE','info');
        return {action:'handled'};
      });
      pi.on('session_shutdown',(_event,ctx)=>ctx.ui.notify('SHUTDOWN_NOTICE'));
    };
  `,
  );
  const config = {
    ...isolatedRuntime(dir),
    stateDir: dir + '/state',
    sessionRoots: [dir + '/sessions'],
    folders: [{ path: cwd }],
    defaults: denyAllPermissions(),
    grants: [{ folder: cwd, read: true, send: true, create: true }],
  };
  config.piArgs.push('-e', extension);
  const bridge = await new Bridge(config).init();
  t.after(async () => {
    for (const name of ['notice-go', 'input-go']) await fs.writeFile(dir + '/' + name, 'yes');
    await bridge.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return { dir, bridge, config, mark: (name) => fs.writeFile(dir + '/' + name, 'yes') };
}

test(
  'real Pi reports a failed handled command and independent async notices through read without changing history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      made = await savedSession(f.bridge),
      session = await f.bridge.session(made.session_id);
    const sent = await f.bridge.send({
      session_id: session.id,

      text: '/audit-fail',
    });
    assert.ok(['started', 'queued', 'handled'].includes(sent.status), JSON.stringify(sent));
    assert.equal(sent.status, 'handled');
    assert.equal(sent.completion, undefined);

    assert.equal(sent.runtime_events, undefined);
    const rpc = f.bridge.pool.get(session.id),
      args = { session_id: session.id, max_bytes: 4096 };
    const read = await f.bridge.read(args);
    assertContextReadResponse(read, args);
    assert.equal(read.runtime_events.generation, rpc.generation);
    assert.ok(
      read.runtime_events.events.some(
        (e) =>
          e.error === 'AUDIT_NATIVE_COMMAND_FAILED' && e.extension_path === 'command:audit-fail',
      ),
    );
    assert.equal(
      (await fs.readFile(session.file, 'utf8')).includes('AUDIT_NATIVE_COMMAND_FAILED'),
      false,
    );

    await rpc.autoReleaseTask;
    const current = await f.bridge.pool.resolve(session);
    await current.command({ type: 'prompt', message: '/audit-deferred' });
    const holding = f.bridge.send({ session_id: session.id, text: 'HELD' });
    await until(() =>
      fs.stat(f.dir + '/held').then(
        () => true,
        () => false,
      ),
    );
    await f.mark('notice-go');
    await until(() =>
      current.runtimeEvents
        .snapshot(4096)
        ?.events.some((e) => e.message === 'UNRELATED_ASYNC_NOTICE'),
    );
    const during = await f.bridge.read(args);
    const notice = during.runtime_events.events.find((e) => e.message === 'UNRELATED_ASYNC_NOTICE');
    assert.equal(notice.level, 'warning');
    assert.equal(notice.prompt_id, undefined);
    await f.mark('input-go');
    assert.ok(
      ['started', 'queued', 'handled'].includes((await holding).status),
      'Expected native prompt admission',
    );
    f.config.grants[0].read = false;
    await assert.rejects(f.bridge.read(args), /NOT_FOUND_OR_DENIED/);
  },
);

test(
  'native handled input notices survive automatic EOF release, without reopening or persisting notices',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const made = await f.bridge.create({
      project: f.config.folders[0].path,

      text: 'NOTIFY_ONLY',
    });
    assert.ok(['started', 'queued', 'handled'].includes(made.status), JSON.stringify(made));
    await until(() => !f.bridge.pool.instances.has(made.session_id) && !f.bridge.autoReleases.size);
    const args = { session_id: made.session_id, max_bytes: 4096 },
      read = await f.bridge.read(args);
    assertContextReadResponse(read, args);
    assert.deepEqual(
      read.runtime_events.events.map((e) => e.message),
      ['INPUT_NOTICE', 'SHUTDOWN_NOTICE'],
    );
    assert.equal(f.bridge.pool.get(made.session_id), null);
    const session = await f.bridge.session(made.session_id);
    assert.equal((await fs.readFile(session.file, 'utf8')).includes('_NOTICE'), false);
  },
);
