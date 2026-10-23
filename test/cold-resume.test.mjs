import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  reserveOwner,
  updateOwner,
  releaseOwner,
  processIdentity,
  readClaim,
  claimFile,
} from '../src/attachments.mjs';
import { RuntimePool } from '../src/rpc.mjs';

test('ordinary join reservations block live writers but exact death permits cold resume in any phase', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-cold-resume-'),
    file = path.join(dir, 'session.jsonl'),
    session = { file, id: 'isolated', header: { id: 'isolated' } },
    ipc = path.join(dir, 'ipc');
  await fs.writeFile(
    file,
    JSON.stringify({ type: 'session', version: 3, id: 'isolated', cwd: dir }) + '\n',
  );
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }),
    exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
    await fs.rm(dir, { recursive: true, force: true });
  });
  const owner = await processIdentity(child.pid),
    record = await reserveOwner(ipc, session, 'tui', owner),
    pool = new RuntimePool({ attachmentDir: ipc }, async () =>
      assert.fail('live writer must block'),
    );
  for (const phase of ['starting', 'ready', 'transitioning']) {
    await updateOwner(ipc, session, record, { phase });
    await assert.rejects(pool.resolve(session), /LIVE_OWNER_UNREACHABLE/);
    await assert.rejects(reserveOwner(ipc, session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
  }
  child.kill('SIGTERM');
  await exited;
  for (const phase of ['starting', 'ready', 'transitioning']) {
    await fs.writeFile(claimFile(ipc, session), JSON.stringify({ ...record, phase }), {
      mode: 0o600,
    });
    const reacquired = await reserveOwner(ipc, session, 'rpc');
    assert.equal(reacquired.noColdReacquire, undefined);
    assert.notEqual(reacquired.generation, record.generation);
    await releaseOwner(ipc, session, reacquired);
    assert.equal(await readClaim(ipc, session), null);
  }
});
