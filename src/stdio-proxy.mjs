import { loadHttpConfig, TOKEN_HEADER, NOT_ADMITTED } from './mcp/http-config.mjs';
import { StdioTransport } from './mcp/protocol-stdio.mjs';
import { forwardedMcpHeaders, isModernRequest, readJson, rpcError } from './mcp/protocol.mjs';
import { MCP_RESPONSE_LIMIT } from './mcp/response-budget.mjs';

// Thin stdio -> one shared loopback Bridge. No runtime, owner lock, reconnect
// queue or automatic retries live here. HTTP authentication stays owner-local.
export function createStdioProxy({
  port,
  token,
  input = process.stdin,
  output = process.stdout,
  fetchImpl = fetch,
}) {
  // The token and port come from loadHttpConfig, which validates them.
  const target = new URL(`http://127.0.0.1:${port}/mcp`);
  return new StdioTransport(
    async (body, signal) => {
      const { id } = body;
      try {
        const response = await fetchImpl(target, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            [TOKEN_HEADER]: token,
            ...(isModernRequest(body) ? forwardedMcpHeaders(body) : {}),
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
        });
        if (!/application\/json/i.test(response.headers.get('content-type') ?? ''))
          throw new Error('INVALID_BACKEND_RESPONSE');
        const result = await readJson(
          response.body,
          MCP_RESPONSE_LIMIT,
          'BACKEND_RESPONSE_TOO_LARGE',
        );
        if (
          result !== null &&
          typeof result === 'object' &&
          !Array.isArray(result) &&
          Object.keys(result).length === 1 &&
          Object.hasOwn(NOT_ADMITTED, result.error) &&
          NOT_ADMITTED[result.error] === response.status
        ) {
          return rpcError(id, -32000, result.error, {
            http_status: response.status,
            recovery: 'NOT_ADMITTED',
          });
        }
        if (result?.jsonrpc !== '2.0' || result.id !== id || (!result.result && !result.error))
          throw new Error('INVALID_BACKEND_RESPONSE');
        return result;
      } catch {
        return rpcError(id, -32000, 'BRIDGE_CONNECTION_LOST', {
          recovery:
            'OUTCOME_UNKNOWN; no automatic replay was attempted. Inspect list/read before deciding whether to submit again.',
        });
      }
    },
    { input, output, capacity: { limit: 16, code: 'PROXY_BUSY' } },
  );
}
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error('OWNER_CONFIG_REQUIRED');
  const proxy = createStdioProxy(await loadHttpConfig(file));
  const close = () => {
    process.stdin.pause();
    proxy.close();
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
  process.stdin.on('end', close);
  process.stdin.on('close', close);
  process.stdin.on('error', close);
  process.stdout.on('error', close);
  proxy.onerror = close;
  proxy.start();
}
if (import.meta.main)
  main().catch(() => {
    console.error('STDIO_PROXY_FAILED');
    process.exitCode = 1;
  });
