import fs from 'node:fs/promises';
import path from 'node:path';
export default (pi) => {
  const record = (ctx, name, value) =>
    fs.writeFile(path.join(ctx.cwd, '..', 'boundary') + name, JSON.stringify(value));
  pi.registerCommand('boundary-switch', {
    handler: async (file, ctx) => {
      const result = await ctx.switchSession(file.trim(), {
        withSession: async () => {
          await record(ctx, '.with-session', true);
          return { restore: false };
        },
      });
      await record(ctx, '.switch', result);
    },
  });
  pi.registerCommand('boundary-new', {
    handler: async (_args, ctx) => {
      await record(
        ctx,
        '.new',
        await ctx.newSession({ setup: async () => record(ctx, '.setup', true) }),
      );
    },
  });
  pi.registerCommand('boundary-fork', {
    handler: async (_args, ctx) => {
      const entry = ctx.sessionManager
        .getEntries()
        .find((e) => e.type === 'message' && e.message.role === 'user');
      await record(ctx, '.fork', await ctx.fork(entry.id));
    },
  });
};
