// Public-API proof only: a private test socket, not a production attachment.
import net from 'node:net';

export default function startupCompanion(pi) {
  const socketPath = process.env.PI_BRIDGE_PROOF_SOCKET;
  if (!socketPath) return;
  let server, ctx, settled = 0;
  const connections = new Set();

  pi.on('agent_settled', () => { settled += 1; });
  pi.on('session_start', async (_event, context) => {
    ctx = context;
    settled = 0;
    server = net.createServer(socket => {
      connections.add(socket);
      socket.on('close', () => connections.delete(socket));
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        if (!buffer.includes('\n')) return;
        try {
          const request = JSON.parse(buffer);
          let data;
          if (request.op === 'read') {
            data = {
              mode: ctx.mode, pid: process.pid,
              sessionId: ctx.sessionManager.getSessionId(),
              sessionFile: ctx.sessionManager.getSessionFile(),
              entries: ctx.sessionManager.getEntries(),
              leafId: ctx.sessionManager.getLeafId(),
              idle: ctx.isIdle(), pending: ctx.hasPendingMessages(),
              settled, tools: pi.getActiveTools(),
            };
          } else if (request.op === 'send') {
            const result = pi.sendUserMessage(request.text, { expandPromptTemplates: true });
            data = { dispatch: 'submitted', returnWasUndefined: result === undefined };
          } else if (request.op === 'shutdown') {
            ctx.shutdown();
            data = { shutdown: 'requested' };
          } else throw new Error('INVALID_PROOF_OPERATION');
          socket.end(JSON.stringify({ data }) + '\n');
        } catch (error) {
          socket.end(JSON.stringify({ error: error.message }) + '\n');
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });
  });
  pi.on('session_shutdown', async () => {
    for (const socket of connections) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    server = undefined;
    ctx = undefined;
  });
}
