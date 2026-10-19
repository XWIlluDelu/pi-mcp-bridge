import { pathToFileURL } from 'node:url';
import { loadHttpConfig, TOKEN_HEADER } from './http-server.mjs';
import { BridgeStdioTransport } from './protocol-stdio.mjs';
import { META, modernMessage, rpcError, MCP_RESPONSE_LIMIT } from './protocol.mjs';

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
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(token)) throw new Error('INVALID_BACKEND_TOKEN');
  const controllers = new Map();
  const encode = (value) =>
    /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !value.startsWith('=?base64?')
      ? value
      : '=?base64?' + Buffer.from(value).toString('base64') + '?=';
  class ProxyTransport extends BridgeStdioTransport {
    line(bytes) {
      let body;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      } catch {
        this.track(this.write(rpcError(null, -32700, 'Parse error')));
        return;
      }
      if (
        !body ||
        Array.isArray(body) ||
        body.jsonrpc !== '2.0' ||
        typeof body.method !== 'string' ||
        (body.params !== undefined &&
          (!body.params || typeof body.params !== 'object' || Array.isArray(body.params))) ||
        (body.id !== undefined &&
          !(
            (typeof body.id === 'number' && Number.isSafeInteger(body.id)) ||
            (typeof body.id === 'string' && Buffer.byteLength(body.id) <= 1024)
          ))
      ) {
        this.track(this.write(rpcError(null, -32600, 'Invalid request')));
        return;
      }
      if (body.method === 'notifications/cancelled' && controllers.has(body.params?.requestId)) {
        controllers.get(body.params.requestId).abort();
        return;
      }
      this.track(this.forward(body));
    }
    async forward(body) {
      // Notifications have no correlation ID and must never share a request slot.
      const key = body.id === undefined ? Symbol() : body.id;
      if (controllers.has(key)) {
        await this.write(rpcError(body.id, -32600, 'Duplicate in-flight request ID'));
        return;
      }
      if (controllers.size >= 16) {
        if (body.id !== undefined)
          await this.write(rpcError(body.id, -32000, 'PROXY_BUSY', { recovery: 'NOT_FORWARDED' }));
        return;
      }
      const controller = new AbortController();
      controllers.set(key, controller);
      try {
        const headers = {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          [TOKEN_HEADER]: token,
        };
        if (modernMessage(body)) {
          const version = body.params?._meta?.[META + 'protocolVersion'];
          if (typeof version === 'string') headers['MCP-Protocol-Version'] = version;
          headers['Mcp-Method'] = body.method;
          const name = body.params?.[body.method === 'resources/read' ? 'uri' : 'name'];
          if (
            ['tools/call', 'prompts/get', 'resources/read'].includes(body.method) &&
            typeof name === 'string'
          )
            headers['Mcp-Name'] = encode(name);
        }
        const response = await fetchImpl(target, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(40000)]),
        });
        if (response.status === 202 && body.id === undefined) return;
        if (!/application\/json/i.test(response.headers.get('content-type') ?? ''))
          throw new Error('INVALID_BACKEND_RESPONSE');
        let size = 0;
        const chunks = [];
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > MCP_RESPONSE_LIMIT) throw new Error('BACKEND_RESPONSE_TOO_LARGE');
          chunks.push(chunk);
        }
        const result = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
        );
        if (body.id !== undefined) {
          if (
            result.jsonrpc !== '2.0' ||
            result.id !== body.id ||
            (!result.result && !result.error)
          )
            throw new Error('INVALID_BACKEND_RESPONSE');
          await this.write(result);
        }
      } catch {
        if (body.id !== undefined && !controller.signal.aborted)
          await this.write(
            rpcError(body.id, -32000, 'BRIDGE_CONNECTION_LOST', {
              recovery: 'QUERY_SAME_REQUEST_ID; no automatic replay was attempted',
            }),
          );
      } finally {
        controllers.delete(key);
      }
    }
    async close() {
      for (const controller of controllers.values()) controller.abort();
      await super.close();
    }
  }
  return new ProxyTransport(null, { input, output });
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
