import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { settledResultSchema } from '../events/settled-result.mjs';
import { assertSingleSessionFile } from './data.mjs';
import { atomicJson, hash } from './storage.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import {
  readClaim,
  ownerAlive,
  assertNoOtherLiveOwner,
  registryTransaction,
  updateOwner,
  claimFile,
} from '../runtime/attachments.mjs';

export async function settledForLocal(bridge, request) {
  bridge.assertOpen();
  if (
    typeof request.sessionCwdHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.sessionCwdHash) ||
    typeof request.generation !== 'string' ||
    request.generation.length === 0 ||
    !Number.isSafeInteger(request.sequence) ||
    request.sequence <= 0 ||
    !(
      request.leafId === null ||
      (typeof request.leafId === 'string' &&
        request.leafId.length > 0 &&
        request.leafId.length <= 128)
    ) ||
    typeof request.aborted !== 'boolean' ||
    !settledResultSchema.safeParse(request.result).success ||
    typeof request.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(request.timestamp))
  )
    throw new Error('INVALID_OWNER_COMMAND');
  const session = await bridge.session(request.session_id);
  if (request.sessionCwdHash !== hash(session.header.cwd ?? null))
    throw new Error('INVALID_OWNER_COMMAND');
  // Serialize the claim check with native replacement. No owner IPC or writer
  // startup is needed to accept a completion, including its first occurrence.
  return registryTransaction(bridge.pool.attachmentDir, async () => {
    const claim = await readClaim(bridge.pool.attachmentDir, session);
    const runtime = bridge.pool.instances.get(session.id);
    if (
      claim?.generation !== request.generation ||
      !(await ownerAlive(claim.owner)) ||
      (claim.kind === 'rpc'
        ? !(runtime instanceof PiRpc) ||
          !runtime.alive ||
          runtime.ownerRecord?.generation !== claim.generation
        : claim.phase !== 'ready' || !bridge.events.supports({ attached: true, record: claim }))
    )
      throw new Error('INVALID_OWNER_COMMAND');
    const previous = bridge.completionSequences.get(session.id);
    if (previous?.generation === request.generation && request.sequence <= previous.sequence)
      throw new Error('INVALID_OWNER_COMMAND');
    bridge.completionSequences.set(session.id, {
      generation: request.generation,
      sequence: request.sequence,
    });
    bridge.events.observe(session, request);
    return {};
  });
}

export function idleCandidateForLocal(bridge, request) {
  bridge.assertOpen();
  const runtime = bridge.pool.instances.get(request.session_id);
  if (
    !(runtime instanceof PiRpc) ||
    !runtime.alive ||
    request.generation !== runtime.ownerRecord?.generation
  )
    throw new Error('INVALID_OWNER_COMMAND');
  runtime.onIdleCandidate?.();
  return {};
}

export async function releaseForLocal(bridge, { session_id, interrupt = false }) {
  bridge.assertOpen();
  if (typeof interrupt !== 'boolean') throw new Error('INVALID_OWNER_COMMAND');
  if (bridge.handoffs.get(session_id)?.kind === 'delete') throw new Error('HANDOFF_PENDING');
  // EOF can be held indefinitely by a native shutdown hook. Interrupt must
  // reach that exact closing child without waiting behind its session lane.
  const closing = bridge.pool.instances.get(session_id);
  if (
    interrupt &&
    closing instanceof PiRpc &&
    (closing.gracefulExitPromise || closing.exitSeal) &&
    !closing.exited
  ) {
    await closing.assertProcessIdentity();
    await updateOwner(bridge.pool.attachmentDir, closing.session, closing.ownerRecord, {
      noColdReacquire: true,
    });
    await closing.stop();
    return { session_id, status: 'released', no_cold_reacquire: true };
  }
  if (bridge.handoffs.get(session_id)?.kind === 'auto_release') await closing?.autoReleaseTask;
  if (bridge.handoffs.has(session_id)) throw new Error('HANDOFF_PENDING');
  const priorStop = bridge.locks.get(`stop:${session_id}`),
    release = { kind: 'release', controller: new AbortController() };
  return bridge.withHandoff(session_id, release, () =>
    bridge.locked(session_id, async () => {
      // An admitted stop finishes its receipt capture before owner shutdown.
      await priorStop?.catch(() => {});
      bridge.assertOpen();
      release.controller.signal.throwIfAborted();
      const owned = bridge.pool.instances.get(session_id);
      let session;
      // Missing history must not strand a child we already own. Existing
      // replacement or unsafe files still require normal identity discovery.
      if (
        owned instanceof PiRpc &&
        owned.alive &&
        (await assertSingleSessionFile(owned.session.file, { allowMissing: true })) === null
      ) {
        await owned.assertProcessIdentity();
        session = owned.session;
      } else session = await bridge.session(session_id);
      const dir = bridge.pool.attachmentDir;
      if (bridge.pool.starting.has(session_id)) throw new Error('RUNTIME_IDLE_UNCONFIRMED');
      const runtime = await bridge.pool.forRead(session);
      if (runtime?.attached) throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
      let exitDetails = {};
      if (runtime) {
        const previousNoCold = runtime.ownerRecord?.noColdReacquire === true;
        try {
          exitDetails = await bridge.pool.shutdown(runtime, release.controller.signal, {
            mode: interrupt ? 'interrupt' : 'idle',
            beforeExit: async () => {
              release.controller.signal.throwIfAborted();
              await updateOwner(dir, session, runtime.ownerRecord, { noColdReacquire: true });
            },
          });
        } catch (error) {
          if (
            error.code === 'RUNTIME_BUSY' &&
            !runtime.gracefulExitPromise &&
            !runtime.exitSeal &&
            runtime.ownerRecord &&
            (runtime.ownerRecord.noColdReacquire === true) !== previousNoCold
          )
            await updateOwner(dir, session, runtime.ownerRecord, {
              noColdReacquire: previousNoCold,
            });
          throw error;
        }
      } else
        await registryTransaction(dir, async () => {
          const current = await assertNoOtherLiveOwner(dir, session);
          if (current && (await ownerAlive(current.owner)))
            throw new Error('LIVE_OWNER_UNREACHABLE');
          release.controller.signal.throwIfAborted();
          await atomicJson(claimFile(dir, session), {
            kind: 'rpc',
            file: session.file,
            sessionId: session.header.id,
            generation: current?.generation ?? randomUUID(),
            owner: null,
            phase: 'released',
            noColdReacquire: true,
          });
        });
      return { session_id, status: 'released', no_cold_reacquire: true, ...exitDetails };
    }),
  );
}

export async function resetColdResume(bridge, { session_id, confirm_local_closed }) {
  bridge.assertOpen();
  if (confirm_local_closed !== true) throw new Error('LOCAL_CLOSE_CONFIRMATION_REQUIRED');
  return bridge.locked(session_id, async () => {
    bridge.assertOpen();
    const session = await bridge.session(session_id),
      dir = bridge.pool.attachmentDir;
    await registryTransaction(dir, async () => {
      const current = await assertNoOtherLiveOwner(dir, session);
      if (current && (await ownerAlive(current.owner))) throw new Error('OWNER_STILL_ALIVE');
      // This confirms cooperative owners only; caller must close unregistered Pi too.
      if (current?.noColdReacquire) await fs.unlink(claimFile(dir, session));
    });
    return { session_id, status: 'reset', no_cold_reacquire: false };
  });
}
