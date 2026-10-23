import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BridgeStdioTransport } from './protocol-stdio.mjs';
import { Bridge } from './bridge.mjs';
import { publicSchemas } from './tool-schemas.mjs';
import {
  toolNames,
  descriptions,
  objectSchema,
  callBridgeTool,
  SERVER_INFO,
  publicError,
} from './protocol.mjs';
import { diagnostics } from './diagnostics.mjs';
import { readOwnerConfig } from './owner-config.mjs';
export function makeServer(bridge, { execute = (run) => run() } = {}) {
  const server = new McpServer(SERVER_INFO);
  for (const name of toolNames)
    server.registerTool(
      name,
      { description: descriptions[name], inputSchema: objectSchema(publicSchemas[name]) },
      (args, extra) =>
        callBridgeTool(bridge, name, args, {
          execute,
          signal: extra.signal,
          requestId: extra.requestId,
        }),
    );
  return server;
}
async function main() {
  const configFile = process.argv[2];
  if (!configFile)
    throw new Error('Usage: node src/server.mjs /absolute/path/to/owner-config.json');
  const { config } = await readOwnerConfig(path.resolve(configFile));
  const bridge = new Bridge(config, undefined, { configFile: path.resolve(configFile) });
  let server,
    transport,
    initializing,
    closing,
    exitCode = 0;
  const close = (code = 0) => {
    exitCode = Math.max(exitCode, code);
    if (closing) return closing;
    diagnostics.emit('service.stopping', { transport: 'stdio' });
    process.stdin.pause();
    bridge.closing = true;
    // Init may still acquire its lock after a stop arrives. Wait for it to settle
    // before cleanup; never let init create resources after close has finished.
    closing = (async () => {
      await initializing?.catch(() => {});
      try {
        await transport?.drain();
        await bridge.close();
      } catch {
        exitCode = 1;
        console.error('SHUTDOWN_FAILED');
      }
      try {
        await server?.close();
      } catch {
        exitCode = 1;
      }
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
    server = makeServer(bridge);
    server.server.onclose = () => {
      void close();
    };
    transport = new BridgeStdioTransport(bridge);
    await server.connect(transport);
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
