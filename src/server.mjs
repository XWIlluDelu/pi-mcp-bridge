import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { StdioTransport } from './protocol-stdio.mjs';
import { dispatchModern } from './protocol.mjs';
import { Bridge } from './bridge.mjs';
import { publicError } from './errors.mjs';
import { diagnostics } from './diagnostics.mjs';
import { readOwnerConfig } from './owner-config.mjs';
async function main() {
  const configFile = process.argv[2];
  if (!configFile)
    throw new Error('Usage: node src/server.mjs /absolute/path/to/owner-config.json');
  const { config } = await readOwnerConfig(path.resolve(configFile));
  const bridge = new Bridge(config, undefined, { configFile: path.resolve(configFile) });
  let transport,
    initializing,
    closing,
    exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (closing) return closing;
    diagnostics.emit('service.stopping', { transport: 'stdio' });
    process.stdin.pause();
    // Init may still acquire its lock after a stop arrives. Wait for it to settle
    // before cleanup; never let init create resources after close has finished.
    closing = (async () => {
      await initializing?.catch(() => {});
      try {
        await bridge.prepareClose();
        await transport?.drain();
        await bridge.close();
      } catch {
        exitCode = 1;
        console.error('SHUTDOWN_FAILED');
      }
      transport?.close();
      process.exit(exitCode);
    })();
    return closing;
  };
  process.on('SIGINT', () => {
    void close();
  });
  process.on('SIGTERM', () => {
    void close();
  });
  process.stdin.on('end', () => {
    void close();
  });
  process.stdin.on('close', () => {
    void close();
  });
  process.stdin.on('error', () => {
    void close(1);
  });
  process.stdout.on('error', () => {
    void close(1);
  });
  process.stdout.on('close', () => {
    void close(1);
  });
  try {
    initializing = bridge.init();
    await initializing;
    if (closing) return closing;
    // A cancelled stdio reply does not cancel an admitted Bridge operation.
    transport = new StdioTransport(async (body) => (await dispatchModern(bridge, body)).message);
    transport.onerror = () => void close(1);
    transport.start();
    diagnostics.emit('service.ready', { transport: 'stdio' });
  } catch (error) {
    console.error(publicError(error));
    await close(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(publicError(e));
    process.exitCode = 1;
  });
