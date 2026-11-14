import { nativeOwner, gatedExtension } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const fixture = (t) =>
  nativeOwner(t, {
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
    },
  });

test(
  'real Pi reports a failed handled command and independent async notices through read without changing history',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      { bridge, id, session } = f;
    f.cleanup.push(() => Promise.all(['notice-go', 'input-go'].map(f.mark)));
    const args = { session_id: id, max_bytes: 4096 };
    const send = (text) => bridge.send({ session_id: id, text });
    const read = () => bridge.read(args);
    assert.equal((await send('/audit-fail')).status, 'handled');
    const rpc = bridge.pool.get(id);
    assert.ok(
      (await read()).runtime_events.events.some(
        (e) =>
          e.error === 'AUDIT_NATIVE_COMMAND_FAILED' && e.extension_path === 'command:audit-fail',
      ),
    );
    assert.doesNotMatch(await fs.readFile(session.file, 'utf8'), /AUDIT_NATIVE_COMMAND_FAILED/);

    await rpc.autoReleaseTask;
    const current = await bridge.pool.resolve(session);
    await current.command({ type: 'prompt', message: '/audit-deferred' });
    const holding = send('HELD');
    await until(() => fs.stat(f.dir + '/held').catch(() => null));
    await f.mark('notice-go');
    await until(() =>
      current.runtimeEvents
        .snapshot(4096)
        ?.events.some((e) => e.message === 'UNRELATED_ASYNC_NOTICE'),
    );
    const during = await read();
    const notice = during.runtime_events.events.find((e) => e.message === 'UNRELATED_ASYNC_NOTICE');
    assert.equal(notice.level, 'warning');
    assert.equal(notice.prompt_id, undefined);
    await f.mark('input-go');
    assert.equal((await holding).status, 'handled');
    f.config.grants[0].read = false;
    await assert.rejects(read(), /NOT_FOUND_OR_DENIED/);
  },
);
