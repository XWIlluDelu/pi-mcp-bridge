// Owner-local Unix control only; deliberately not an MCP tool or HTTP route.
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { opaqueId } from './storage.mjs';
import { privateDirectory } from './attachments.mjs';
import { readOwnerConfig } from './owner-config.mjs';
export function ownerSocket(config) {
  const dir = config.attachmentDir ?? path.join(config.stateDir, 'ipc');
  return path.join(dir, `owner-${opaqueId(config.stateDir).slice(3, 11)}.sock`);
}
export async function serveOwnerControl(bridge) {
  const socket = ownerSocket(bridge.config);
  await privateDirectory(path.dirname(socket));
  // Called only after acquiring this service namespace's lifetime mutex.
  const previous = await fs.lstat(socket).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (previous) {
    if (!previous.isSocket() || previous.uid !== process.getuid())
      throw new Error('INVALID_OWNER_SOCKET');
    await fs.unlink(socket);
  }
  const connections = new Set(),
    operations = new Set(),
    handoffs = new Set();
  let closing = false;
  const server = net.createServer({ allowHalfOpen: true }, (connection) => {
    connections.add(connection);
    connection.setEncoding('utf8');
    let buffer = '',
      admitted = false,
      controller,
      completed = false;
    connection.setTimeout(30000, () => connection.destroy());
    connection.on('error', () => {});
    connection.on('close', () => {
      connections.delete(connection);
      if (!completed) controller?.abort();
    });
    connection.on('end', () => {
      if (!completed) controller?.abort();
    });
    connection.on('data', (chunk) => {
      if (admitted || closing) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 8192) {
        connection.destroy();
        return;
      }
      if (!buffer.includes('\n')) return;
      admitted = true;
      const task = (async () => {
        try {
          const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
          const methods = {
            release: 'releaseForLocal',
            reset: 'resetColdResume',
            handoff: 'handoffForLocal',
            handoff_cancel: 'cancelHandoff',
          };
          if (
            !request ||
            !Object.hasOwn(methods, request.op) ||
            !/^ps_[a-f0-9]{32}$/.test(request.session_id)
          )
            throw new Error('INVALID_OWNER_COMMAND');
          if (request.op === 'handoff') {
            controller = new AbortController();
            handoffs.add(controller);
            connection.setTimeout(0);
          }
          const data = await bridge[methods[request.op]](request, { signal: controller?.signal });
          completed = true;
          connection.end(JSON.stringify({ data }) + '\n');
        } catch (error) {
          completed = true;
          connection.end(
            JSON.stringify({
              error: {
                code: controller?.signal.aborted
                  ? 'HANDOFF_CANCELLED'
                  : (error.code ?? error.message),
              },
            }) + '\n',
          );
        } finally {
          if (controller) handoffs.delete(controller);
        }
      })();
      operations.add(task);
      void task.finally(() => operations.delete(task)).catch(() => {});
    });
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    await fs.chmod(socket, 0o600);
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    async close() {
      closing = true;
      for (const controller of handoffs) controller.abort();
      const stopped = new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...operations]);
      for (const connection of connections) connection.destroy();
      await stopped;
    },
  };
}
export async function ownerRequest(config, request, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const connection = net.createConnection(ownerSocket(config));
    let buffer = '';
    const cancel = () => connection.destroy(new Error('HANDOFF_CANCELLED'));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    connection.on('close', () => signal?.removeEventListener('abort', cancel));
    connection.setEncoding('utf8');
    connection.setTimeout(request.op === 'handoff' ? 0 : 30000, () =>
      connection.destroy(new Error('OWNER_CONTROL_TIMEOUT')),
    );
    connection.on('error', reject);
    connection.on('connect', () => {
      if (request.op === 'handoff') connection.write(JSON.stringify(request) + '\n');
      else connection.end(JSON.stringify(request) + '\n');
    });
    connection.on('data', (chunk) => {
      buffer += chunk;
    });
    connection.on('end', () => {
      connection.end();
      try {
        const result = JSON.parse(buffer);
        if (result.error)
          throw Object.assign(new Error(result.error.code), { code: result.error.code });
        resolve(result.data);
      } catch (error) {
        reject(error);
      }
    });
  });
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
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.code ?? error.message);
    process.exitCode = 1;
  });
