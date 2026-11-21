// Owner-local Unix control only; deliberately not an MCP tool or HTTP route.
import net from 'node:net';
import { json } from 'node:stream/consumers';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ifMissing, opaqueId } from './core/storage.mjs';
import { privateDirectory } from './runtime/attachments.mjs';
import { readOwnerConfig, registryDirectory } from './core/owner-config.mjs';
import { readRequest, listenPrivate } from './runtime/attachment-protocol.mjs';
const methods = {
  release: 'releaseForLocal',
  settled: 'settledForLocal',
  idle_candidate: 'idleCandidateForLocal',
  reset: 'resetColdResume',
  handoff: 'handoffForLocal',
  handoff_cancel: 'cancelHandoff',
};
export function ownerSocket(config) {
  return path.join(
    registryDirectory(config),
    `owner-${opaqueId(config.stateDir).slice(3, 11)}.sock`,
  );
}
export async function serveOwnerControl(bridge) {
  const socket = ownerSocket(bridge.config);
  await privateDirectory(path.dirname(socket));
  // Called only after acquiring this service namespace's lifetime mutex.
  const previous = await fs.lstat(socket).catch(ifMissing);
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid())
      throw new Error('INVALID_OWNER_SOCKET');
    await fs.unlink(socket);
  }
  const connections = new Map();
  let closing = false;
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    const requestState = {};
    connections.set(connection, requestState);
    connection.setTimeout(30000, () => connection.destroy());
    connection.on('error', () => {});
    connection.once('close', async () => {
      requestState.controller?.abort();
      // Keep disconnected native work in the same shutdown ledger until it ends.
      await requestState.task?.catch(() => {});
      connections.delete(connection);
    });
    connection.once('end', () => requestState.controller?.abort());
    readRequest(connection, 8192, (frame) => {
      if (!closing) return (requestState.task = handle(frame));
    });
    async function handle(frame) {
      let reply;
      try {
        const request = JSON.parse(frame);
        if (
          !request ||
          !Object.hasOwn(methods, request.op) ||
          !/^ps_[a-f0-9]{32}$/.test(request.session_id)
        )
          throw new Error('INVALID_OWNER_COMMAND');
        if (request.op === 'handoff') {
          requestState.controller = new AbortController();
          connection.setTimeout(0);
        }
        reply = {
          data: await bridge[methods[request.op]](request, {
            signal: requestState.controller?.signal,
          }),
        };
      } catch (error) {
        const code = requestState.controller?.signal.aborted
          ? 'HANDOFF_CANCELLED'
          : (error.code ?? error.message);
        reply = { error: { code } };
      }
      requestState.controller = null;
      connection.end(JSON.stringify(reply) + '\n');
    }
  });
  try {
    await listenPrivate(server, socket);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    async close() {
      closing = true;
      for (const { controller } of connections.values()) controller?.abort();
      const stopped = new Promise((resolve) => server.close(resolve));
      await Promise.allSettled(connections.values().map(({ task }) => task));
      for (const connection of connections.keys()) connection.destroy();
      await stopped;
    },
  };
}
export async function ownerRequest(config, request, { signal } = {}) {
  if (signal?.aborted) throw new Error('HANDOFF_CANCELLED');
  const handoff = request.op === 'handoff';
  const connection = net.createConnection({ path: ownerSocket(config), signal });
  try {
    connection.setTimeout(handoff ? 0 : 30000, () =>
      connection.destroy(new Error('OWNER_CONTROL_TIMEOUT')),
    );
    const frame = JSON.stringify(request) + '\n';
    if (handoff) connection.write(frame);
    else connection.end(frame);
    const result = await json(connection);
    if (result.error)
      throw Object.assign(new Error(result.error.code), { code: result.error.code });
    return result.data;
  } catch (error) {
    if (signal?.aborted) throw new Error('HANDOFF_CANCELLED');
    throw error;
  } finally {
    connection.destroy();
  }
}
async function main() {
  const [file, op, session_id, confirmation, ...rest] = process.argv.slice(2);
  if (
    !file ||
    !['release', 'reset'].includes(op) ||
    !session_id ||
    rest.length ||
    (op === 'release' && confirmation !== undefined && confirmation !== '--interrupt') ||
    (op === 'reset' && confirmation !== '--confirm-local-closed')
  )
    throw new Error(
      'Usage: node src/owner-runtime.mjs OWNER_CONFIG release SESSION_ID [--interrupt] | reset SESSION_ID --confirm-local-closed',
    );
  const { config } = await readOwnerConfig(path.resolve(file));
  console.log(
    JSON.stringify(
      await ownerRequest(config, {
        op,
        session_id,
        ...(op === 'reset'
          ? { confirm_local_closed: true }
          : { interrupt: confirmation === '--interrupt' }),
      }),
    ),
  );
}
if (import.meta.main)
  main().catch((error) => {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
