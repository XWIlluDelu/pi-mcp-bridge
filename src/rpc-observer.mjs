// Public Pi context observation for a Bridge-owned child. Never owns a claim.
import net from 'node:net';
import fs from 'node:fs/promises';
export default function rpcObserver(pi) {
  const value = process.env.PI_MCP_RPC_OBSERVER;
  if (!value) return;
  const { socket, generation } = JSON.parse(value);
  let server, context;
  const connections = new Set();
  // Keep uncertainty across factory replacement in the same owned process.
  const key = Symbol.for('pi-mcp-bridge.rpc-observer.preflight');
  const preflight =
    globalThis[key]?.generation === generation
      ? globalThis[key]
      : (globalThis[key] = {
          generation,
          preparingUnconfirmed: false,
          overlapUnconfirmed: false,
          nonRpcInputSeen: false,
        });
  // ctx.isIdle() omits prompt preflight. Settlement has no input identity;
  // once seen inputs overlap, it cannot establish which preparation finished.
  pi.on('input', (event) => {
    if (event.source !== 'rpc') preflight.nonRpcInputSeen = true;
    if (preflight.preparingUnconfirmed) preflight.overlapUnconfirmed = true;
    preflight.preparingUnconfirmed = true;
  });
  pi.on('agent_settled', () => {
    if (!preflight.overlapUnconfirmed) preflight.preparingUnconfirmed = false;
  });
  pi.on('session_start', async (_event, ctx) => {
    context = ctx;
    if (server) return;
    server = net.createServer((connection) => {
      connections.add(connection);
      let body = '';
      connection.setEncoding('utf8');
      connection.setTimeout(5000, () => connection.destroy());
      connection.on('error', () => {});
      connection.on('close', () => connections.delete(connection));
      connection.on('data', (chunk) => {
        body += chunk;
        if (Buffer.byteLength(body) > 8192) {
          connection.destroy();
          return;
        }
        if (!body.includes('\n')) return;
        let result;
        try {
          const request = JSON.parse(body.slice(0, body.indexOf('\n')));
          if (
            !context ||
            request.op !== 'state' ||
            request.generation !== generation ||
            request.file !== context.sessionManager.getSessionFile() ||
            request.sessionId !== context.sessionManager.getSessionId()
          )
            throw new Error('RUNTIME_SESSION_CHANGED');
          result = {
            data: {
              isIdle: context.isIdle(),
              hasPendingMessages: context.hasPendingMessages(),
              preparingUnconfirmed: preflight.preparingUnconfirmed,
              nonRpcInputSeen: preflight.nonRpcInputSeen,
            },
          };
        } catch (error) {
          result = { error: error.message };
        }
        connection.end(JSON.stringify({ generation, ...result }) + '\n');
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await fs.chmod(socket, 0o600);
  });
  pi.on('session_shutdown', async () => {
    context = null;
    // Reload/replacement recreates factories after shutdown handlers finish.
    // Close the owning listener (which unlinks its Unix socket) before rebinding.
    for (const connection of connections) connection.destroy();
    const listener = server;
    server = undefined;
    if (listener) await new Promise((resolve) => listener.close(resolve));
  });
}
