import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertNoOtherLiveOwner,
  AttachedRuntime,
  claimFile,
  privateDirectory,
  processIdentity,
  readClaim,
  readOwnerRecord,
  reserveOwner,
} from '../src/attachments.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-owner-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await privateDirectory(dir);
  const session = { file: path.join(dir, 'session.jsonl'), header: { id: 'original' } };
  const record = {
    file: session.file,
    sessionId: session.header.id,
    kind: 'rpc',
    generation: 'fixture-generation',
    phase: 'starting',
    owner: await processIdentity(),
  };
  const file = claimFile(dir, session);
  await fs.writeFile(
    session.file,
    JSON.stringify({ type: 'session', version: 3, ...session.header, cwd: dir }) + '\n',
    { mode: 0o600 },
  );
  await fs.writeFile(file, JSON.stringify(record), { mode: 0o600 });
  return {
    dir,
    session,
    record,
    file,
    replacement: { file: session.file, header: { id: 'replacement' } },
  };
}

test('both direct lookup and cross-identity scan reject unsafe owner records', async (t) => {
  const cases = {
    'malformed JSON': async (f) => fs.writeFile(f.file, '{'),
    'missing owner': async (f) =>
      fs.writeFile(f.file, JSON.stringify({ ...f.record, owner: null })),
    'oversized record': async (f) =>
      fs.writeFile(f.file, JSON.stringify({ ...f.record, padding: 'x'.repeat(8192) })),
    'group-readable record': async (f) => fs.chmod(f.file, 0o640),
    'symbolic link': async (f) => {
      const target = path.join(f.dir, 'target');
      await fs.rename(f.file, target);
      await fs.symlink(target, f.file);
    },
    directory: async (f) => {
      await fs.unlink(f.file);
      await fs.mkdir(f.file, { mode: 0o700 });
    },
  };
  for (const [name, mutate] of Object.entries(cases))
    await t.test(name, async (t) => {
      const f = await fixture(t);
      await mutate(f);
      await assert.rejects(readClaim(f.dir, f.session), { code: 'INVALID_ATTACHMENT_RECORD' });
      await assert.rejects(assertNoOtherLiveOwner(f.dir, f.replacement), {
        code: 'INVALID_ATTACHMENT_RECORD',
      });
    });
});

test('validated scans preserve exact process identity and all ownership phases', async (t) => {
  const f = await fixture(t);
  for (const kind of ['rpc', 'tui', 'host', 'extension'])
    for (const phase of ['starting', 'ready', 'transitioning']) {
      const record = {
        ...f.record,
        kind,
        phase,
        ...(kind !== 'rpc' ? { socket: path.join(f.dir, 'fixture.sock') } : {}),
      };
      await fs.writeFile(f.file, JSON.stringify(record));
      assert.deepEqual(await readClaim(f.dir, f.session), record);
      await assert.rejects(assertNoOtherLiveOwner(f.dir, f.replacement), {
        code: 'LIVE_OWNER_UNREACHABLE',
      });
      await fs.writeFile(
        f.file,
        JSON.stringify({ ...record, owner: { ...record.owner, start: 'obsolete-start' } }),
      );
      await assertNoOtherLiveOwner(f.dir, f.replacement);
    }
  await fs.unlink(f.file);
  assert.equal(await readClaim(f.dir, f.session), null);
  await assertNoOtherLiveOwner(f.dir, f.replacement);
});

test('a different native session ID still owns its target path, but cannot serve control for this session', async (t) => {
  const f = await fixture(t);
  const record = {
    ...f.record,
    sessionId: 'different',
    kind: 'extension',
    socket: path.join(f.dir, 'fixture.sock'),
    phase: 'ready',
  };
  await fs.writeFile(f.file, JSON.stringify(record));
  assert.deepEqual(await readClaim(f.dir, f.session), record);
  await assert.rejects(reserveOwner(f.dir, f.session, 'rpc'), { code: 'LIVE_OWNER_UNREACHABLE' });
  await assert.rejects(new AttachedRuntime({ attachmentDir: f.dir }, f.session, record).start(), {
    code: 'RUNTIME_SESSION_CHANGED',
  });
});

test('ownership survives control mismatch; only using the live endpoint requires its current protocol', async (t) => {
  const f = await fixture(t);
  for (const metadata of [
    { kind: 'unsupported-endpoint' },
    { generation: null },
    { socket: '/unusable/endpoint' },
    { unexpected: true },
  ]) {
    const record = {
      ...f.record,
      kind: 'extension',
      socket: path.join(f.dir, 'fixture.sock'),
      phase: 'ready',
      ...metadata,
    };
    await fs.writeFile(f.file, JSON.stringify(record));
    assert.deepEqual(await readClaim(f.dir, f.session), record);
    await assert.rejects(reserveOwner(f.dir, f.session, 'rpc'), { code: 'LIVE_OWNER_UNREACHABLE' });
    await assert.rejects(assertNoOtherLiveOwner(f.dir, f.replacement), {
      code: 'LIVE_OWNER_UNREACHABLE',
    });
    await assert.rejects(new AttachedRuntime({ attachmentDir: f.dir }, f.session, record).start(), {
      code: 'ATTACHMENT_PROTOCOL_MISMATCH',
    });
  }
  const differentOwner = { ...f.record.owner, start: 'different-process-start' };
  assert.equal(await readOwnerRecord(f.dir, f.file, undefined, { owner: differentOwner }), null);
});

test('known different paths do not inherit owner damage; ambiguous paths still block admission', async (t) => {
  const f = await fixture(t);
  const unrelated = { file: path.join(f.dir, 'unrelated.jsonl') };
  await fs.writeFile(f.file, JSON.stringify({ ...f.record, owner: null }));
  await assertNoOtherLiveOwner(f.dir, unrelated);
  await assert.rejects(readClaim(f.dir, f.session), { code: 'INVALID_ATTACHMENT_RECORD' });
  // Killing a PID requires proving that it does not also own another session.
  await assert.rejects(readOwnerRecord(f.dir, f.file, undefined, { owner: f.record.owner }), {
    code: 'INVALID_ATTACHMENT_RECORD',
  });
  await fs.writeFile(f.file, JSON.stringify({ ...f.record, file: null }));
  await assert.rejects(assertNoOtherLiveOwner(f.dir, unrelated), {
    code: 'INVALID_ATTACHMENT_RECORD',
  });
});

test('dead ownership can be replaced without its old control metadata; a local pause is retained', async (t) => {
  const f = await fixture(t);
  const record = {
    ...f.record,
    owner: { ...f.record.owner, start: 'exited-process-start' },
    kind: 'unsupported-endpoint',
    generation: null,
    socket: '/unusable/endpoint',
    handoffId: 'unusable',
    unsupportedControlMetadata: true,
  };
  await fs.writeFile(f.file, JSON.stringify(record));
  assert.deepEqual(await readClaim(f.dir, f.session), record);
  await assertNoOtherLiveOwner(f.dir, f.replacement);
  const replacement = await reserveOwner(f.dir, f.session, 'rpc');
  assert.notEqual(replacement.generation, record.generation);
  assert.equal(replacement.unsupportedControlMetadata, undefined);
  await fs.writeFile(f.file, JSON.stringify({ ...record, noColdReacquire: true }));
  await assert.rejects(reserveOwner(f.dir, f.session, 'rpc'), { code: 'COLD_REACQUIRE_BLOCKED' });
  await fs.writeFile(f.file, JSON.stringify({ ...record, owner: f.record.owner }));
  await assert.rejects(reserveOwner(f.dir, f.session, 'rpc'));
  await assert.rejects(assertNoOtherLiveOwner(f.dir, f.replacement));
});
