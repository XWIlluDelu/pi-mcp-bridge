// Human TUI shortcut only: deliberately no slash command or model/MCP tool.
import fs from 'node:fs/promises';
import path from 'node:path';
import { inside } from './permissions.mjs';
import { opaqueId } from './storage.mjs';
import { readOwnerConfig, editPermission, permissionDetails } from './owner-config.mjs';
const labels = {
  list: 'List',
  read: 'Read',
  send: 'Send prompt',
  command: 'Execute command',
  stop: 'Stop execution',
  create: 'Create and send',
  delete: 'Delete',
};
export default function ownerPermissions(pi) {
  const file = process.env.PI_MCP_OWNER_CONFIG;
  let generation = 0,
    dialog;
  pi.on('session_start', (_event, ctx) => {
    generation++;
    if (ctx.mode === 'tui' && file) ctx.ui.setStatus('mcp-permissions', 'Permissions: Ctrl+Alt+P');
  });
  pi.on('session_shutdown', () => {
    generation++;
    dialog?.abort();
  });
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
      const token = generation;
      dialog = new AbortController();
      const options = { signal: dialog.signal };
      const current = () => {
        if (token !== generation || options.signal.aborted) throw new Error('OWNER_MENU_CLOSED');
      };
      try {
        let snapshot = await readOwnerConfig(file);
        const cwd = await fs.realpath(ctx.cwd);
        const choice = await ctx.ui.select(
          'MCP permissions',
          ['This session', 'This project', 'Another configured project', 'Defaults'],
          options,
        );
        current();
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
          const stat = await fs.lstat(sessionFile);
          if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('SESSION_NOT_SAVED');
          target = { session_id: opaqueId(`${sessionFile}\0${id}`), cwd };
          title = 'This session';
        } else {
          let folder = cwd;
          if (choice === 'Another configured project') {
            folder = await ctx.ui.select(
              'Choose project',
              snapshot.config.folders.map((f) => f.path),
              options,
            );
            current();
            if (!folder) return;
          }
          if (!snapshot.config.folders.some((f) => f.path === folder)) {
            ctx.ui.notify('Choose a project from the configured folder list.', 'warning');
            return;
          }
          target = { folder: await fs.realpath(folder) };
          title = `Project: ${target.folder}`;
        }
        const actions = Object.keys(labels).filter(
          (action) => !target.session_id || action !== 'create',
        );
        while (true) {
          current();
          const rows = actions.map((action) => {
            const info = permissionDetails(snapshot.config, action, target);
            return `${labels[action]}: ${info.allowed ? 'Allowed' : 'Blocked'} — ${typeof info.explicit === 'boolean' ? 'explicit' : 'inherited'} (${info.source})`;
          });
          const selected = await ctx.ui.select(title, [...rows, 'Done'], options);
          current();
          if (!selected || selected === 'Done') return;
          const action = actions[rows.indexOf(selected)];
          if (!action) return;
          const value = await ctx.ui.select(
            `${labels[action]} — ${title}`,
            ['Allow', 'Block', 'Inherit'],
            options,
          );
          current();
          if (!value) continue;
          snapshot = await editPermission(
            file,
            snapshot.revision,
            target,
            action,
            { Allow: true, Block: false, Inherit: null }[value],
          );
          current();
          ctx.ui.notify('Saved. Applies to the next MCP request.', 'info');
        }
      } catch (error) {
        if (
          error.message !== 'OWNER_MENU_CLOSED' &&
          token === generation &&
          !options.signal.aborted
        ) {
          const message =
            {
              OWNER_CONFIG_CHANGED: 'Configuration changed elsewhere. Reopen the menu.',
              OWNER_CONFIG_BUSY: 'Another permission edit is in progress. Try again.',
              SESSION_NOT_SAVED: 'Save this session before changing its permissions.',
            }[error.message] ?? 'Could not update permissions. Check the owner configuration.';
          ctx.ui.notify(message, 'error');
        }
      } finally {
        dialog = null;
      }
    },
  });
}
