// Companion command for an already running ordinary native Pi TUI.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readOwnerConfig } from './owner-config.mjs';
import { ownerRequest } from './owner-runtime.mjs';
import { processIdentity, readClaim } from './attachments.mjs';

export default function joinExtension(
  pi,
  { file = process.env.PI_MCP_OWNER_CONFIG, dir = process.env.PI_MCP_ATTACH_DIR } = {},
) {
  if (!file || !dir) return;
  let pending;
  pi.on('session_shutdown', () => {
    if (pending && !pending.switching) pending.controller.abort();
  });
  pi.on('session_before_switch', async (event) => {
    if (!pending?.switching) return;
    // Revalidate the reservation in the public pre-open hook. Returning cancel
    // is essential: Pi reports extension hook errors without cancelling switch.
    try {
      const held = await readClaim(dir, {
        file: pending.result.session_file,
        header: { id: pending.nativeId },
      });
      if (
        event.reason === 'resume' &&
        event.targetSessionFile === pending.result.session_file &&
        held?.generation === pending.result.generation &&
        held.phase === 'starting' &&
        held.handoffId === pending.request.handoff_id
      )
        return;
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
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          'Wait for this local session to finish before joining another session.',
          'warning',
        );
        return;
      }
      const operation = { controller: new AbortController(), switching: false };
      pending = operation;
      let config,
        switched = false,
        mayRelease = true;
      try {
        ({ config } = await readOwnerConfig(file));
        if ((config.attachmentDir ?? path.join(config.stateDir, 'ipc')) !== dir)
          throw new Error('HANDOFF_DIRECTORY_MISMATCH');
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
        operation.result = await ownerRequest(config, operation.request, {
          signal: operation.controller.signal,
        });
        operation.controller.signal.throwIfAborted();
        const held = await readClaim(dir, {
          file: operation.result.session_file,
          header: { id: operation.result.native_id },
        });
        operation.nativeId = operation.result.native_id;
        if (held?.generation !== operation.result.generation)
          throw new Error('RUNTIME_SESSION_CHANGED');
        if (!ctx.isIdle() || ctx.hasPendingMessages()) throw new Error('LOCAL_SESSION_BUSY');
        operation.controller.signal.throwIfAborted();
        operation.switching = true;
        // A thrown switch can occur after SessionManager.open or partial runtime
        // replacement. Only a returned cancellation proves it is safe to release.
        mayRelease = false;
        const result = await ctx.switchSession(operation.result.session_file);
        switched = result.cancelled === false;
        mayRelease = result.cancelled === true;
        if (!switched)
          ctx.ui.notify(
            'Session switch cancelled. The target remains released; /bridge-join can retry.',
            'warning',
          );
      } catch (error) {
        if (!operation.switching && !operation.controller.signal.aborted)
          ctx.ui.notify(`Join failed: ${error.code ?? error.message}`, 'error');
        else if (!operation.switching)
          try {
            ctx.ui.notify(
              'Join cancelled. Any shutdown already started will finish normally.',
              'info',
            );
          } catch {}
        else
          try {
            ctx.ui.notify(
              `Session switch failed: ${error.code ?? error.message}. Close this Pi before retrying; its target reservation is retained.`,
              'error',
            );
          } catch {}
      } finally {
        if (!switched && mayRelease && config && operation.request) {
          try {
            await ownerRequest(config, { ...operation.request, op: 'handoff_cancel' });
          } catch {
            try {
              ctx.ui.notify(
                'Could not clear the join reservation. Close this Pi before retrying from another process.',
                'warning',
              );
            } catch {}
          }
        }
        if (pending === operation) pending = undefined;
      }
    },
  });
}
