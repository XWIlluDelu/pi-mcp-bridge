// Human TUI shortcut only: deliberately no slash command or model/MCP tool.
import path from 'node:path';
import { assertSingleSessionFile } from './core/data.mjs';
import { ACTIONS, inside } from './core/permissions.mjs';
import { sessionKey } from './core/storage.mjs';
import { readOwnerConfig, editPermission, permissionDetails } from './core/owner-config.mjs';
const labels = {
  list: 'List',
  read: 'Read',
  send: 'Send prompt',
  command: 'Execute command',
  stop: 'Stop execution',
  create: 'Create with optional first prompt',
  delete: 'Delete',
};
const choices = ['This session', 'This project', 'Another configured project', 'Defaults'];
const values = { Allow: true, Block: false, Inherit: null };
export default function ownerPermissions(pi) {
  const file = process.env.PI_MCP_OWNER_CONFIG;
  let dialog;
  pi.on('session_start', (_event, ctx) => {
    dialog?.abort();
    if (ctx.mode === 'tui' && file) ctx.ui.setStatus('mcp-permissions', 'Permissions: Ctrl+Alt+P');
  });
  pi.on('session_shutdown', () => dialog?.abort());
  pi.registerShortcut('ctrl+alt+p', {
    description: 'Manage MCP project and session permissions',
    handler: async (ctx) => {
      if (ctx.mode !== 'tui' || !ctx.hasUI || dialog) return;
      if (!file) {
        ctx.ui.notify(
          'Set PI_MCP_OWNER_CONFIG to your bridge owner configuration file.',
          'warning',
        );
        return;
      }
      dialog = new AbortController();
      const { signal } = dialog;
      const select = async (title, items) => {
        const selected = await ctx.ui.select(title, items, { signal });
        signal.throwIfAborted();
        return selected;
      };
      try {
        let snapshot = await readOwnerConfig(file);
        const choice = await select('MCP permissions', choices);
        if (!choice) return;
        let target, title;
        if (choice === 'Defaults') {
          target = { default: true };
          title = 'Default permissions';
        } else if (choice === 'This session') {
          const sessionFile = ctx.sessionManager.getSessionFile(),
            id = ctx.sessionManager.getSessionId();
          if (
            !sessionFile ||
            !snapshot.config.sessionRoots.some((root) => inside(sessionFile, root))
          ) {
            ctx.ui.notify('This session is outside the bridge session storage.', 'warning');
            return;
          }
          const header = ctx.sessionManager.getHeader();
          await assertSingleSessionFile(sessionFile, { allowMissing: true });
          target = {
            session_id: sessionKey(sessionFile, id),
            cwd: header?.cwd ? path.resolve(header.cwd) : null,
          };
          title = 'This session';
        } else {
          let folder;
          if (choice === 'Another configured project') {
            const paths = [
              ...snapshot.config.folders.map(({ path }) => path),
              ...(snapshot.config.grants ?? []).flatMap(({ folder }) => (folder ? [folder] : [])),
            ];
            folder = await select('Choose project', [
              ...new Set(paths.map((p) => path.resolve(p))),
            ]);
            if (!folder) return;
          } else folder = path.resolve(ctx.cwd);
          target = { folder };
          title = `Project: ${folder}`;
        }
        const actions = ACTIONS.filter((action) => !target.session_id || action !== 'create');
        while (true) {
          signal.throwIfAborted();
          const rows = new Map();
          for (const action of actions) {
            const { allowed, explicit, source } = permissionDetails(
              snapshot.config,
              action,
              target,
            );
            const row = `${labels[action]}: ${allowed ? 'Allowed' : 'Blocked'} — ${typeof explicit === 'boolean' ? 'explicit' : 'inherited'} (${source})`;
            rows.set(row, action);
          }
          const action = rows.get(await select(title, [...rows.keys(), 'Done']));
          if (!action) return;
          const value = await select(`${labels[action]} — ${title}`, Object.keys(values));
          if (!value) continue;
          snapshot = await editPermission(file, snapshot.revision, target, action, values[value]);
          signal.throwIfAborted();
          ctx.ui.notify('Saved. Applies to the next MCP request.', 'info');
        }
      } catch (error) {
        if (!signal.aborted) {
          const message =
            {
              OWNER_CONFIG_CHANGED: 'Configuration changed elsewhere. Reopen the menu.',
              OWNER_CONFIG_BUSY: 'Another permission edit is in progress. Try again.',
              JSON_FILE_TOO_LARGE: 'This edit exceeds the 1 MiB owner configuration limit.',
              SESSION_FILE_ALIAS_NOT_ALLOWED: "This session's storage cannot be safely identified.",
              UNSAFE_NATIVE_SESSION_STORAGE: "This session's storage cannot be safely identified.",
            }[error.message] ?? 'Could not update permissions. Check the owner configuration.';
          ctx.ui.notify(message, 'error');
        }
      } finally {
        dialog = null;
      }
    },
  });
}
