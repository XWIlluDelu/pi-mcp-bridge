import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioTransport } from './mcp/protocol-stdio.mjs';
import { dispatchModern } from './mcp/protocol.mjs';
import { Bridge } from './core/bridge.mjs';
import { publicError } from './core/errors.mjs';
import { diagnostics } from './core/diagnostics.mjs';
import { readOwnerConfig } from './core/owner-config.mjs';
// Both entry points own the same lifecycle. A signal during Bridge.init must
// wait until init has settled, including any resources it acquired.
export async function runService(bridge, createService, { stdio = false, failureCode } = {}) {
  let service,
    initializing,
    closing,
    exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (closing) return closing;
    if (stdio) process.stdin.pause();
    closing = (async () => {
      await initializing?.catch(() => {});
      try {
        await (service ? service.close() : bridge.close());
      } catch {
        exitCode = 1;
        console.error('SHUTDOWN_FAILED');
      }
      process.exit(exitCode);
    })();
    return closing;
  };
  const stop = () => void close();
  const fail = () => void close(1);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (stdio) {
    process.stdin.on('end', stop);
    process.stdin.on('close', stop);
    process.stdin.on('error', fail);
    process.stdout.on('error', fail);
    process.stdout.on('close', fail);
  }
  try {
    initializing = bridge.init().then(() => {
      if (closing) return;
      service = createService(fail);
      return service.listen();
    });
    await initializing;
  } catch (error) {
    console.error(publicError(error, failureCode));
    await close(1);
  }
}
async function main() {
  if (!process.argv[2])
    throw new Error('Usage: node src/server.mjs /absolute/path/to/owner-config.json');
  const configFile = path.resolve(process.argv[2]);
  const { config } = await readOwnerConfig(configFile);
  const bridge = new Bridge(config, undefined, { configFile });
  return runService(
    bridge,
    (fail) => {
      // A cancelled stdio reply does not cancel an admitted Bridge operation.
      const transport = new StdioTransport(
        async (body) => (await dispatchModern(bridge, body)).message,
      );
      transport.onerror = fail;
      return {
        listen() {
          transport.start();
          diagnostics.emit('service.ready', { transport: 'stdio' });
        },
        async close() {
          diagnostics.emit('service.stopping', { transport: 'stdio' });
          try {
            await bridge.prepareClose();
            await transport.drain();
            await bridge.close();
          } finally {
            transport.close();
          }
        },
      };
    },
    { stdio: true },
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(publicError(e));
    process.exitCode = 1;
  });
