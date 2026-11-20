import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { settledResultSchema } from '../events/settled-result.mjs';
import { utf16String } from '../mcp/schema.mjs';
import { assertSingleSessionFile } from './data.mjs';
import { atomicJson, hash } from './storage.mjs';
import { PiRpc } from '../runtime/rpc.mjs';
import {
  readClaim,
  sameOwner,
  retireClaim,
  reserveOwner,
  vacantClaim,
  ownerAlive,
  assertNoOtherLiveOwner,
  registryTransaction,
  updateOwner,
  claimFile,
} from '../runtime/attachments.mjs';

const settledOccurrence = z.object({
  sessionCwdHash: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().min(1),
  sequence: z.number().int().positive(),
  leafId: utf16String(128).min(1).nullable(),
  aborted: z.boolean(),
  result: settledResultSchema,
  timestamp: z.string().refine((value) => Number.isFinite(Date.parse(value))),
});
const handoffRequest = z.object({
  requester: z.object({ pid: z.number().int().positive(), start: z.string(), boot: z.string() }),
  handoff_id: z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
});

function hasOwnedGeneration(runtime, generation) {
  return (
    runtime instanceof PiRpc && runtime.alive && runtime.ownerRecord?.generation === generation
  );
}

export async function settledForLocal(bridge, request) {
  bridge.assertOpen();
  if (!settledOccurrence.safeParse(request).success) throw new Error('INVALID_OWNER_COMMAND');
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
        ? !hasOwnedGeneration(runtime, claim.generation)
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
  if (!hasOwnedGeneration(runtime, request.generation)) throw new Error('INVALID_OWNER_COMMAND');
  runtime.onIdleCandidate?.();
  return {};
}

async function closeLocalWriter(bridge, id, marker, signal, close) {
  const release = bridge.autoReleaseInProgress(id);
  if (release) await release;
  if (bridge.handoff(id)) throw new Error('HANDOFF_PENDING');
  const stop = bridge.lane(id, 'stop');
  return bridge.withHandoff(id, marker, () =>
    bridge.locked(id, async () => {
      // Fence new stops before draining the one already admitted.
      await stop?.catch(() => {});
      bridge.assertOpen();
      signal.throwIfAborted();
      const { requester, kind } = marker;
      if (requester && !(await ownerAlive(requester))) throw new Error('HANDOFF_REQUESTER_GONE');
      const owned = bridge.pool.instances.get(id);
      let session;
      // Explicit release can reach an owned child even after its history disappears.
      if (
        kind === 'release' &&
        owned instanceof PiRpc &&
        owned.alive &&
        (await assertSingleSessionFile(owned.session.file, { allowMissing: true })) === null
      ) {
        await owned.assertProcessIdentity();
        session = owned.session;
      } else session = await bridge.session(id);
      if (bridge.pool.starting.has(id)) throw new Error('RUNTIME_IDLE_UNCONFIRMED');
      const runtime = await bridge.pool.forRead(session);
      if (runtime?.attached) throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
      return close(session, runtime, bridge.pool.attachmentDir);
    }),
  );
}

function validateHandoff(request) {
  if (!handoffRequest.safeParse(request).success) throw new Error('INVALID_OWNER_COMMAND');
}
export async function handoffForLocal(bridge, request, { signal } = {}) {
  validateHandoff(request);
  bridge.assertOpen();
  const { session_id, requester, handoff_id } = request;
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const marker = { handoff_id, requester, controller };
  try {
    return await closeLocalWriter(
      bridge,
      session_id,
      marker,
      signal,
      async (session, runtime, dir) => {
        // Cancellation after seal cannot undo shutdown. Finish observing the
        // exact child's normal exit, but never open a cancelled destination.
        const exitDetails = runtime
          ? await bridge.pool.shutdown(runtime, signal, {
              mode: 'wait_idle',
              beforeExit: async () => {
                signal.throwIfAborted();
                if (!(await ownerAlive(requester))) throw new Error('HANDOFF_REQUESTER_GONE');
              },
            })
          : {};
        signal?.throwIfAborted();
        const reservation = await reserveOwner(dir, session, 'handoff', requester, {
          id: handoff_id,
          signal,
        });
        if (signal?.aborted) {
          await cancelHandoff(bridge, request);
          signal.throwIfAborted();
        }
        return {
          session_id,
          status: 'reserved',
          session_file: session.file,
          native_id: session.header.id,
          generation: reservation.generation,
          no_cold_reacquire: reservation.noColdReacquire === true,
          ...exitDetails,
        };
      },
    );
  } catch (error) {
    if (signal.aborted) throw new Error('HANDOFF_CANCELLED');
    throw error;
  }
}
export async function cancelHandoff(bridge, request) {
  validateHandoff(request);
  const pending = bridge.handoff(request.session_id);
  if (pending?.handoff_id === request.handoff_id && sameOwner(pending.requester, request.requester))
    pending.controller.abort();
  const session = await bridge.session(request.session_id).catch((error) => {
    if (error.message === 'NOT_FOUND_OR_DENIED') return null; // Already deleted.
    throw error;
  });
  const dir = bridge.pool.attachmentDir;
  if (session)
    await registryTransaction(dir, async () => {
      const current = await readClaim(dir, session),
        owner = request.requester;
      if (
        current?.handoffId !== request.handoff_id ||
        current.kind !== 'handoff' ||
        !sameOwner(current.owner, owner)
      )
        return;
      await retireClaim(dir, session, current);
    });
  return { session_id: request.session_id, status: 'cancelled' };
}

export async function releaseForLocal(bridge, { session_id, interrupt = false }) {
  bridge.assertOpen();
  if (typeof interrupt !== 'boolean') throw new Error('INVALID_OWNER_COMMAND');
  if (bridge.handoff(session_id)?.kind === 'delete') throw new Error('HANDOFF_PENDING');
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
  const controller = new AbortController();
  const release = { kind: 'release', controller };
  const { signal } = controller;
  return closeLocalWriter(bridge, session_id, release, signal, async (session, runtime, dir) => {
    let exitDetails = {};
    if (runtime) {
      const previousNoCold = runtime.ownerRecord?.noColdReacquire === true;
      try {
        exitDetails = await bridge.pool.shutdown(runtime, signal, {
          mode: interrupt ? 'interrupt' : 'idle',
          beforeExit: async () => {
            signal.throwIfAborted();
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
        const current = await vacantClaim(dir, session);
        signal.throwIfAborted();
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
  });
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
