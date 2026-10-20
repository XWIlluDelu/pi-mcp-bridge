import { z } from 'zod';
import { PiRpc } from './rpc.mjs';

// This is a targeted cold reopen, not AgentSession.reload() or slash forwarding.
// Keep orchestration in the Bridge process; the closing child cannot own receipts.
export const reloadSchema = z
  .object({
    session_id: z.string().min(1).max(128),
    request_id: z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/),
    timeout_ms: z.number().int().min(50).max(30000).optional(),
  })
  .strict();

export async function reopenOwned(bridge, session, save, authorize) {
  let runtime,
    fenced = false,
    details = { method: 'rpc_reopen', session_id: session.id };
  const failure = (code) => Object.assign(new Error(code), { reload_details: details });
  try {
    await authorize();
    runtime = await bridge.pool.forRead(session); // Never start a saved or externally owned session.
    if (!runtime) throw failure('RELOAD_NOT_RUNNING');
    if (!(runtime instanceof PiRpc) || runtime.attached) throw failure('RELOAD_UNSUPPORTED');
    await authorize();
    // A local handoff can reserve the owner while our lookups await I/O.
    if (bridge.handoffs.has(session.id)) throw failure('HANDOFF_PENDING');
    bridge.handoffs.set(session.id, { kind: 'reload' });
    runtime.handoffPending = true;
    fenced = true;
    await runtime.assertIdle({ busy: 'RELOAD_BUSY', unconfirmed: 'RELOAD_IDLE_UNCONFIRMED' });
    await runtime.drainRecovery();
    if (runtime.recoveryError()) throw failure('RECOVERY_PERSIST_FAILED');
    details = { ...details, previous_generation: runtime.generation, phase: 'exiting' };
    await save({ status: 'unknown', ...details });
    await authorize();
    // Exact normal EOF/exit; no abort, signals, timeout kill or second writer.
    await runtime.gracefulExit();
    if (bridge.pool.instances.get(session.id) === runtime) bridge.pool.instances.delete(session.id);
    details = { ...details, phase: 'reopening' };
    await save({ status: 'unknown', ...details });
    await authorize();
    const next = await bridge.pool.resolve(session);
    if (next.attached) throw failure('RELOAD_OWNER_CHANGED');
    details = { ...details, generation: next.generation };
    const state = await next.dispatch({ type: 'get_state' });
    if (state.sessionFile !== session.file || state.sessionId !== session.header.id)
      throw failure('RUNTIME_SESSION_CHANGED');
    await authorize();
    return await save({
      status: 'accepted',
      ...details,
      phase: 'completed',
      model: state.model ? { provider: state.model.provider, id: state.model.id } : null,
      thinking_level: typeof state.thinkingLevel === 'string' ? state.thinkingLevel : null,
    });
  } catch (error) {
    error.reload_details = details;
    // An exit/start/storage failure after EOF is not proof nothing happened.
    if (runtime?.gracefulExitPromise) error.uncertain = true;
    throw error;
  } finally {
    if (fenced) {
      bridge.handoffs.delete(session.id);
      if (!runtime.gracefulExitPromise) runtime.handoffPending = false;
    }
  }
}
