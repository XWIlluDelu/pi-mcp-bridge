import { pathToFileURL } from 'node:url';
import { loadHttpConfig, TOKEN_HEADER, NOT_ADMITTED, assertBackendToken } from './http-config.mjs';
import { StdioTransport } from './protocol-stdio.mjs';
import { modernHeaderFields, readJson, rpcError } from './protocol.mjs';
import { MCP_RESPONSE_LIMIT } from './response-budget.mjs';

// Thin stdio -> one shared loopback Bridge. No runtime, owner lock, reconnect
// queue or automatic retries live here. HTTP authentication stays owner-local.
export function createStdioProxy({
  url,
  token,
  input = process.stdin,
  output = process.stdout,
  fetchImpl = fetch,
}) {
  const target = new URL(url);
  if (
    target.protocol !== 'http:' ||
    target.hostname !== '127.0.0.1' ||
    !target.port ||
    target.pathname !== '/mcp' ||
    target.search ||
    target.hash ||
    target.username ||
    target.password
  )
    throw new Error('INVALID_PROXY_URL');
  assertBackendToken(token);
  const encode = (value) =>
    /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !value.startsWith('=?base64?')
      ? value
      : '=?base64?' + Buffer.from(value).toString('base64') + '?=';
  return new StdioTransport(
    async (body, signal) => {
      const { id } = body;
      try {
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json',
          [TOKEN_HEADER]: token,
        };
        for (const [name, value] of Object.entries(modernHeaderFields(body)))
          if (typeof value === 'string')
            headers[name] = name === 'mcp-name' ? encode(value) : value;
        const response = await fetchImpl(target, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(40000)]),
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
  const { token, port } = await loadHttpConfig(file);
  const proxy = createStdioProxy({ url: `http://127.0.0.1:${port}/mcp`, token });
  let closing;
  const close = () =>
    (closing ??= (async () => {
      process.stdin.pause();
      await proxy.close();
      await proxy.drain();
    })());
  process.on('SIGINT', () => void close());
  process.on('SIGTERM', () => void close());
  process.stdin.on('end', () => void close());
  process.stdin.on('close', () => void close());
  process.stdin.on('error', () => void close());
  process.stdout.on('error', () => void close());
  proxy.onerror = () => void close();
  await proxy.start();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('STDIO_PROXY_FAILED');
    process.exitCode = 1;
  });
