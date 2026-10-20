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
} from '../src/attachments.mjs';
import { RuntimePool } from '../src/rpc.mjs';

test('only a quitting TUI marker plus exact process death lifts a handoff cold-resume fence', async (t) => {
  const dir = await fs.mkdtemp('/tmp/pi-cold-resume-'),
    file = path.join(dir, 'session.jsonl'),
    session = { file, header: { id: 'isolated' } },
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
    record = await reserveOwner(ipc, session, 'tui', owner);
  await updateOwner(ipc, session, record, {
    noColdReacquire: true,
    phase: 'transitioning',
    coldReacquireAfterExit: true,
  });
  const pool = new RuntimePool({ attachmentDir: ipc }, async () =>
    assert.fail('live marked writer must block'),
  );
  await assert.rejects(pool.resolve({ ...session, id: 'isolated' }), /LIVE_OWNER_UNREACHABLE/);
  await assert.rejects(reserveOwner(ipc, session, 'rpc'), /LIVE_OWNER_UNREACHABLE/);
  child.kill('SIGTERM');
  await exited;
  for (const changes of [
    { coldReacquireAfterExit: false },
    { coldReacquireAfterExit: true, phase: 'starting' },
  ]) {
    await updateOwner(ipc, session, record, changes);
    await assert.rejects(reserveOwner(ipc, session, 'rpc'), /COLD_REACQUIRE_BLOCKED/);
  }
  await updateOwner(ipc, session, record, { phase: 'transitioning', coldReacquireAfterExit: true });
  const reacquired = await reserveOwner(ipc, session, 'rpc');
  assert.equal(reacquired.noColdReacquire, undefined);
  assert.equal(reacquired.coldReacquireAfterExit, undefined);
  assert.notEqual(reacquired.generation, record.generation);
  await releaseOwner(ipc, session, reacquired);
  assert.equal(await readClaim(ipc, session), null);
});
