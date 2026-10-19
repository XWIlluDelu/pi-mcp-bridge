// Owner-local transfer using the existing session lock and ownership registry.
import { randomUUID } from 'node:crypto';
import { PiRpc } from './rpc.mjs';
import { atomicJson } from './storage.mjs';
import {
  ownerAlive,
  readClaim,
  registryTransaction,
  updateOwner,
  claimFile,
  assertNoOtherLiveOwner,
} from './attachments.mjs';

function validate(request) {
  const { requester, handoff_id } = request;
  if (
    !Number.isSafeInteger(requester?.pid) ||
    requester.pid < 1 ||
    typeof requester.start !== 'string' ||
    typeof requester.boot !== 'string' ||
    typeof handoff_id !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(handoff_id)
  )
    throw new Error('INVALID_OWNER_COMMAND');
}
const sameRequester = (a, b) => a?.pid === b.pid && a.start === b.start && a.boot === b.boot;
export async function idleHandoff(bridge, request, { signal } = {}) {
  validate(request);
  bridge.assertOpen();
  const { session_id, requester, handoff_id } = request;
  if (bridge.handoffs.has(session_id)) throw new Error('HANDOFF_PENDING');
  const controller = new AbortController();
  signal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const priorStop = bridge.locks.get(`stop:${session_id}`);
  bridge.handoffs.set(session_id, { handoff_id, requester, controller });
  try {
    return await bridge.locked(session_id, async () => {
      // Fence new stops immediately, but let an admitted stop finish its queue
      // recovery before fencing RPC dispatch. Reuse its existing independent lock.
      await priorStop?.catch(() => {});
      bridge.assertOpen();
      signal?.throwIfAborted();
      if (!(await ownerAlive(requester))) throw new Error('HANDOFF_REQUESTER_GONE');
      const session = await bridge.session(session_id),
        dir = bridge.pool.attachmentDir;
      if (bridge.pool.starting.has(session_id)) throw new Error('RUNTIME_IDLE_UNCONFIRMED');
      const runtime = await bridge.pool.forRead(session);
      if (runtime?.attached) throw new Error('EXTERNAL_OWNER_NOT_RELEASABLE');
      if (runtime && !(runtime instanceof PiRpc)) throw new Error('BRIDGE_OWNED_RUNTIME_REQUIRED');
      if (runtime) {
        runtime.handoffPending = true;
        try {
          await runtime.waitForHandoff(signal);
          await updateOwner(dir, session, runtime.ownerRecord, { noColdReacquire: true });
          signal?.throwIfAborted();
          if (!(await ownerAlive(requester))) throw new Error('HANDOFF_REQUESTER_GONE');
          // Cancellation after EOF cannot undo shutdown. Finish observing the
          // exact child's normal exit, but never open a cancelled destination.
          await runtime.gracefulExit();
          bridge.pool.instances.delete(session_id);
        } finally {
          if (!runtime.gracefulExitPromise) runtime.handoffPending = false;
        }
      }
      signal?.throwIfAborted();
      const reservation = await registryTransaction(dir, async () => {
        signal?.throwIfAborted();
        await assertNoOtherLiveOwner(dir, session);
        const current = await readClaim(dir, session);
        if (current && (await ownerAlive(current.owner))) throw new Error('LIVE_OWNER_UNREACHABLE');
        if (!(await ownerAlive(requester))) throw new Error('HANDOFF_REQUESTER_GONE');
        // Reserve the future TUI BEFORE it calls switchSession/opens the file.
        // session_start replaces this same-process reservation with its endpoint.
        const record = {
          kind: 'tui',
          file: session.file,
          sessionId: session.header.id,
          generation: randomUUID(),
          owner: requester,
          phase: 'starting',
          noColdReacquire: true,
          handoffId: handoff_id,
          socket: dir + `/${requester.pid}-${handoff_id.slice(0, 8)}.sock`,
        };
        await atomicJson(claimFile(dir, session), record);
        return record;
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
        no_cold_reacquire: true,
      };
    });
  } catch (error) {
    if (signal.aborted) throw new Error('HANDOFF_CANCELLED');
    throw error;
  } finally {
    bridge.handoffs.delete(session_id);
  }
}
export async function cancelHandoff(bridge, request) {
  validate(request);
  const pending = bridge.handoffs.get(request.session_id);
  if (
    pending?.handoff_id === request.handoff_id &&
    sameRequester(pending.requester, request.requester)
  )
    pending.controller.abort();
  const session = await bridge.session(request.session_id),
    dir = bridge.pool.attachmentDir;
  await registryTransaction(dir, async () => {
    const current = await readClaim(dir, session),
      owner = request.requester;
    if (
      current?.handoffId !== request.handoff_id ||
      current.kind !== 'tui' ||
      current.phase !== 'starting' ||
      !sameRequester(current.owner, owner)
    )
      return;
    await atomicJson(claimFile(dir, session), { ...current, phase: 'released', owner: null });
  });
  return { session_id: request.session_id, status: 'cancelled' };
}
