// Public Pi context observation for a Bridge-owned child. Never owns a claim.
import net from 'node:net';
import fs from 'node:fs/promises';
import { prepareContextRead } from './context-read.mjs';
import { LiveMessageObserver } from './live-message.mjs';
import { MAX_ATTACHMENT_REQUEST_BYTES } from './attachment-protocol.mjs';
export default function rpcObserver(pi) {
  const value = process.env.PI_MCP_RPC_OBSERVER;
  if (!value) return;
  const { socket, generation } = JSON.parse(value);
  let server, context;
  const connections = new Set();
  const live = new LiveMessageObserver('rpc_message_events');
  for (const name of [
    'agent_start',
    'agent_settled',
    'message_start',
    'message_update',
    'message_end',
  ])
    pi.on(name, (event) => live.update(event));
  // Keep uncertainty across factory replacement in the same owned process.
  const key = Symbol.for('pi-mcp-bridge.rpc-observer.preflight');
  const preflight =
    globalThis[key]?.generation === generation
      ? globalThis[key]
      : (globalThis[key] = {
          generation,
          nonRpcInputSeen: false,
        });
  // ctx.isIdle() omits prompt preflight. Only the pipe owner has RPC ACKs;
  // independent extension inputs need an explicit interrupting owner release
  // if their completion cannot be established through the native interface.
  pi.on('input', (event) => {
    if (event.source !== 'rpc') preflight.nonRpcInputSeen = true;
  });
  // An owned RPC is one file-bound writer. Veto before Pi opens another file;
  // session_shutdown is too late. Native TUI/host owners use their own lifecycle.
  pi.on('session_before_switch', (event, ctx) => {
    if (
      event.reason !== 'resume' ||
      event.targetSessionFile !== ctx.sessionManager.getSessionFile()
    )
      return { cancel: true };
  });
  pi.on('session_before_fork', () => ({ cancel: true }));
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
        if (Buffer.byteLength(body) > MAX_ATTACHMENT_REQUEST_BYTES) {
          connection.destroy();
          return;
        }
        if (!body.includes('\n')) return;
        let result;
        try {
          const request = JSON.parse(body.slice(0, body.indexOf('\n')));
          if (
            !context ||
            !['state', 'read'].includes(request.op) ||
            request.generation !== generation ||
            request.file !== context.sessionManager.getSessionFile() ||
            request.sessionId !== context.sessionManager.getSessionId()
          )
            throw new Error('RUNTIME_SESSION_CHANGED');
          result = {
            data:
              request.op === 'state'
                ? {
                    isIdle: context.isIdle(),
                    hasPendingMessages: context.hasPendingMessages(),
                    nonRpcInputSeen: preflight.nonRpcInputSeen,
                  }
                : {
                    sessionFile: request.file,
                    sessionId: request.sessionId,
                    ...prepareContextRead(
                      {
                        entries: context.sessionManager.getEntries(),
                        leafId: context.sessionManager.getLeafId(),
                        live: live.snapshot(),
                      },
                      request.body,
                    ),
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
    live.reset();
    // Reload/replacement recreates factories after shutdown handlers finish.
    // Close the owning listener (which unlinks its Unix socket) before rebinding.
    for (const connection of connections) connection.destroy();
    const listener = server;
    server = undefined;
    if (listener) await new Promise((resolve) => listener.close(resolve));
  });
}
