import { nativeOwner, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import { assertContextReadResponse } from './fixtures/read-pages.mjs';

async function fixture(t) {
  return nativeOwner(t, {
    prefix: 'native-events',
    async configure(context) {
      await gatedExtension(
        context,
        `
        pi.registerCommand('audit-fail', { handler: () => { throw new Error('AUDIT_NATIVE_COMMAND_FAILED'); } });
        pi.registerCommand('audit-deferred', { handler: (_args, ctx) => {
          void wait('notice-go').then(() => ctx.ui.notify('UNRELATED_ASYNC_NOTICE', 'warning'));
        } });
        pi.on('input', async (event) => {
          if (event.text === 'HELD') {
            await mark('held');
            await wait('input-go');
          }
          return { action: 'handled' };
        });
      `,
      );
      context.cleanup.push(() =>
        Promise.all(
          ['notice-go', 'input-go'].map((name) => fs.writeFile(path.join(context.dir, name), 'go')),
        ),
      );
    },
  });
}

test(
  'real Pi reports a failed handled command and independent async notices through read without changing history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { session } = f;
    const sent = await f.bridge.send({
      session_id: session.id,
      text: '/audit-fail',
    });
    assert.equal(sent.status, 'handled', JSON.stringify(sent));
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
    assert.equal((await holding).status, 'handled');
    f.config.grants[0].read = false;
    await assert.rejects(f.bridge.read(args), /NOT_FOUND_OR_DENIED/);
  },
);
