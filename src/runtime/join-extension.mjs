// Companion command for an already running ordinary native Pi TUI.
import { randomUUID } from 'node:crypto';
import { readCompanionConfig } from './companion-profile.mjs';
import { ownerRequest } from '../owner-runtime.mjs';
import { processIdentity, readClaim, updateOwner } from './attachments.mjs';

const idle = (ctx) => ctx.isIdle() && !ctx.hasPendingMessages();

export default function joinExtension(
  pi,
  { file = process.env.PI_MCP_OWNER_CONFIG, dir = process.env.PI_MCP_ATTACH_DIR } = {},
) {
  if (!file || !dir) return;
  let pending;
  async function reservation({ session, generation, request }, phase) {
    const held = await readClaim(dir, session);
    if (
      held?.kind !== 'handoff' ||
      held.phase !== phase ||
      held.generation !== generation ||
      held.handoffId !== request.handoff_id
    )
      throw new Error('RUNTIME_SESSION_CHANGED');
    return held;
  }
  pi.on('session_shutdown', () => {
    if (pending && !pending.switching) pending.controller.abort();
  });
  pi.on('session_before_switch', async (event) => {
    const operation = pending;
    if (!operation?.switching) return;
    // Revalidate the reservation in the public pre-open hook. Returning cancel
    // is essential: Pi reports extension hook errors without cancelling switch.
    try {
      if (event.reason === 'resume' && event.targetSessionFile === operation.session.file) {
        await reservation(operation, 'opening');
        if (pending === operation) return;
      }
    } catch {}
    return { cancel: true };
  });
  pi.registerShortcut('ctrl+alt+j', {
    description: 'Cancel a waiting Bridge session join',
    handler: async (ctx) => {
      if (ctx.mode !== 'tui') return;
      if (pending?.switching) {
        ctx.ui.notify('The native session switch is already in progress.', 'warning');
        return;
      }
      pending?.controller.abort();
    },
  });
  pi.registerCommand('bridge-join', {
    description: 'Join a Bridge session after its current work finishes: /bridge-join ps_…',
    handler: async (args, ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI) return;
      if (pending) {
        ctx.ui.notify('A join is already waiting. Press Ctrl+Alt+J to cancel it.', 'warning');
        return;
      }
      const session_id = args.trim();
      if (!/^ps_[a-f0-9]{32}$/.test(session_id)) {
        ctx.ui.notify('Usage: /bridge-join ps_SESSION_ID', 'warning');
        return;
      }
      if (!idle(ctx)) {
        ctx.ui.notify(
          'Wait for this local session to finish before joining another session.',
          'warning',
        );
        return;
      }
      const controller = new AbortController();
      const operation = { controller };
      pending = operation;
      let config;
      const notify = (message, level) => {
        try {
          ctx.ui.notify(message, level);
        } catch {}
      };
      try {
        ({ config } = await readCompanionConfig(file, dir));
        operation.request = {
          op: 'handoff',
          session_id,
          requester: await processIdentity(),
          handoff_id: randomUUID(),
        };
        ctx.ui.notify(
          'Waiting for Bridge work and queued messages to finish. Ctrl+Alt+J cancels the join.',
          'info',
        );
        const result = await ownerRequest(config, operation.request, { signal: controller.signal });
        controller.signal.throwIfAborted();
        if (result.ui?.unavailable?.some(({ phase }) => phase === 'shutdown'))
          ctx.ui.notify(
            'The previous Pi exited, but its shutdown dialog was unavailable. Extension cleanup may be incomplete.',
            'warning',
          );
        const session = { file: result.session_file, header: { id: result.native_id } };
        Object.assign(operation, { session, generation: result.generation });
        const held = await reservation(operation, 'reserved');
        // This registry transition serializes with deletion's revocation. Once
        // native switch starts, a later async hook may still delay actual open.
        // Do not claim that the public pre-switch hook closes that window.
        await updateOwner(dir, session, held, { phase: 'opening' });
        if (!idle(ctx)) throw new Error('LOCAL_SESSION_BUSY');
        controller.signal.throwIfAborted();
        operation.switching = true;
        // A thrown switch can occur after SessionManager.open or partial runtime
        // replacement. Only a returned cancellation proves it is safe to release.
        const switched = await ctx.switchSession(session.file);
        if (switched.cancelled === true) {
          operation.switching = false;
          ctx.ui.notify(
            'Session switch cancelled. The target remains released; /bridge-join can retry.',
            'warning',
          );
        }
      } catch (error) {
        const reason = error.code ?? error.message;
        if (operation.switching)
          notify(
            `Session switch failed: ${reason}. Close this Pi before retrying; its target reservation is retained.`,
            'error',
          );
        else if (controller.signal.aborted)
          notify('Join cancelled. Any shutdown already started will finish normally.', 'info');
        else notify(`Join failed: ${reason}`, 'error');
      } finally {
        if (!operation.switching && config && operation.request) {
          try {
            await ownerRequest(config, { ...operation.request, op: 'handoff_cancel' });
          } catch {
            notify(
              'Could not clear the join reservation. Close this Pi before retrying from another process.',
              'warning',
            );
          }
        }
        pending = undefined;
      }
    },
  });
}
