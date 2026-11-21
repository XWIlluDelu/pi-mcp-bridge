import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Bridge } from '../src/core/bridge.mjs';

import { ownerAlive, waitOwnerExit } from '../src/runtime/attachments.mjs';
import { fixture, until } from './fixtures/model-runtime.mjs';

const moduleUrl = (file) => new URL('../src/' + file, import.meta.url).href;
async function worker(t, source) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }),
    exited = once(child, 'exit'),
    message = once(child, 'message');
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const ready = await Promise.race([
    message.then(([data]) => data),
    exited.then(() => assert.fail(stderr)),
  ]);
  return { child, exited, ready };
}

test(
  'service crash releases its lifetime mutex and stale control socket, not a surviving native writer',
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t),
      session = await f.bridge.session(f.id);
    await f.bridge.close();
    await fs.writeFile(f.gate + '.hold-shutdown', 'hold');
    const w = await worker(
      t,
      `
    process.env.PI_MODEL_GATE=${JSON.stringify(f.gate)};
    import {Bridge} from ${JSON.stringify(moduleUrl('core/bridge.mjs'))};
    const bridge=await new Bridge(${JSON.stringify(f.config)}).init();
    const runtime=await bridge.pool.resolve(await bridge.session(${JSON.stringify(f.id)}));
    process.send(runtime.ownerRecord.owner);
  `,
    );
    t.after(async () => {
      if (await ownerAlive(w.ready)) {
        process.kill(w.ready.pid, 'SIGTERM');
        await waitOwnerExit(w.ready);
      }
    });
    const contender = new Bridge(f.config);
    await assert.rejects(contender.init(), /BRIDGE_ALREADY_RUNNING/);
    await contender.close();
    w.child.kill('SIGKILL');
    await w.exited;
    await until(() =>
      fs.stat(f.gate + '.shutdown-start').then(
        () => true,
        () => false,
      ),
    );
    const restarted = await new Bridge(f.config).init();
    try {
      assert.equal(await ownerAlive(w.ready), true);
      await assert.rejects(restarted.pool.resolve(session), /LIVE_OWNER_UNREACHABLE/);
      await fs.writeFile(f.gate + '.exit', 'go');
      await waitOwnerExit(w.ready);
      assert.equal((await restarted.pool.resolve(session)).alive, true);
    } finally {
      await restarted.close();
    }
  },
);
