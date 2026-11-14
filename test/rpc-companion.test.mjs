import test from 'node:test';
import assert from 'node:assert/strict';
import { RpcClient } from './fixtures/pi.mjs';
import { nativePiCli } from './fixtures/isolated-runtime.mjs';
import { nativeOwner, fauxArgs } from './fixtures/native-owner.mjs';
import { until } from './fixtures/until.mjs';
import { ownerAlive, readClaim } from '../src/attachments.mjs';

test('an ordinary native RPC shares its session and keeps shutdown authority', async (t) => {
  const f = await nativeOwner(t);
  const extension = new URL('../src/attach-extension.mjs', import.meta.url).pathname;
  const local = new RpcClient({
    cliPath: nativePiCli,
    cwd: f.cwd,
    env: f.env,
    args: [...f.config.piArgs, '--session', f.session.file, '-e', extension, ...fauxArgs],
  });
  f.cleanup.push(() => local.stop());
  await local.start();
  await local.getState();
  const owner = await readClaim(f.config.attachmentDir, f.session);
  assert.equal(owner.kind, 'extension');
  assert.equal((await f.bridge.stop({ session_id: f.id })).reason, 'STOP_UNSUPPORTED');
  const sent = await f.bridge.send({ session_id: f.id, text: 'companion dispatch proof' });
  assert.equal(sent.status, 'dispatched');
  assert.equal(sent.admission, 'unobservable');
  await until(async () => !(await local.getState()).isStreaming);
  assert.match(
    JSON.stringify(await f.bridge.read({ session_id: f.id })),
    /companion dispatch proof/,
  );
  assert.equal((await readClaim(f.config.attachmentDir, f.session)).generation, owner.generation);
  await f.bridge.close();
  assert.equal(await ownerAlive(owner.owner), true);
});
