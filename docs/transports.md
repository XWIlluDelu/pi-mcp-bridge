# MCP transports

Both transports expose the same [public tools](api.md) and [permissions](configuration.md#seven-independent-rights).

## Choose a process topology

### One client: direct stdio

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/path/to/owner-config.json"]
}
```

The client owns this Bridge process. Stdin EOF, SIGINT or SIGTERM stops new dispatch, drains dispatched requests, closes owned RPCs and releases the service lock. Waiting mutations may return `BRIDGE_CLOSING`. External Pi owners are disconnected and retain their writer claims; see [runtime lifecycle](runtime.md#shutdown-and-in-flight-acks).

Each line is one UTF-8 JSON-RPC message; stdout contains no logs. Oversized input is rejected and discarded through its next newline. The owned Pi RPC stream is also LF-delimited: fragmented UTF-8, CRLF and Unicode line/paragraph separators are preserved, and unfinished EOF frames are discarded.

### Multiple clients: one HTTP Bridge

Start with the private owner configuration from [Start locally](../README.md#start-locally), with your native session paths and grants already set. Add this top-level field to that file, choosing an unused local port:

```json
{
  "http": {
    "port": 43123,
    "tokenFile": "/absolute/private/path/bridge-token"
  }
}
```

Create the token as the same user that will run Bridge. Replace the path below with `http.tokenFile`; its private parent directory must already exist. This writes a random token with mode 0600 and refuses to overwrite an existing file. It does not print the token:

```sh
node --input-type=module - /absolute/private/path/bridge-token <<'JS'
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
await writeFile(process.argv[2], randomBytes(32).toString('base64url') + '\n', {
  mode: 0o600,
  flag: 'wx',
});
JS
```

Start the service using that owner file:

```sh
node /absolute/path/to/pi-mcp-bridge/src/http-server.mjs /absolute/private/path/owner.json
```

From another terminal, verify authentication and protocol discovery with a read-only request. This reads the token from the configured file without putting it in shell history or command-line arguments:

```sh
node --input-type=module - /absolute/private/path/owner.json <<'JS'
import { readFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const token = (await readFile(config.http.tokenFile, 'utf8')).replace(/\n$/, '');
const version = '2026-07-28';
const response = await fetch(`http://127.0.0.1:${config.http.port}/mcp`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'x-pi-bridge-token': token,
    'MCP-Protocol-Version': version,
    'Mcp-Method': 'server/discover',
  },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'server/discover',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  }),
  signal: AbortSignal.timeout(10000),
});
const result = await response.json();
if (!response.ok || result.error) {
  throw new Error(`HTTP ${response.status}: ${JSON.stringify(result.error ?? result)}`);
}
console.log(JSON.stringify(result, null, 2));
JS
```

A successful response identifies the server as `pi-session-bridge` and includes its version, supported protocols and capabilities. Discovery does not start a Pi writer or require session grants; it verifies the local endpoint, not native session access. `401 UNAUTHORIZED` means the running service and caller do not share the same token.

The service binds **127.0.0.1** and accepts **POST /mcp**. The owner config and token must be canonical absolute paths to regular files owned by the service user, with no group/other access; symlinks are rejected. The token contains 32–256 characters from `A-Z a-z 0-9 . _ ~ -`, optionally followed by one newline in its file.

The HTTP service and each stdio proxy load the token once at startup. Replacing
the file does not revoke the token already loaded by a running service or update
an existing proxy. Changing only the file's contents also does not appear in
`health.restart_required`. Coordinate a token change with restarting the service
and its proxies at a safe work boundary, and update the tunnel's injected token
to match. Then repeat the discovery check above.

Every request requires `x-pi-bridge-token: TOKEN`. Authentication occurs before body parsing. The backend accepts only `Host: 127.0.0.1:PORT` and rejects any `Origin` header. A remote tunnel must authenticate its public caller, rewrite upstream Host, remove browser Origin and inject the private backend token. The loopback service supplies owner-local authentication, not an MCP OAuth server.

Clients/gateways must accept `application/json` and `text/event-stream`; the backend returns ordinary JSON with `Cache-Control: no-store`. There is no MCP session ID, CORS browser access or GET/SSE endpoint. A disconnected client does not stop the shared service.

### Multiple stdio-only clients: thin shared proxy

Start the HTTP service, then configure each client with:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/pi-mcp-bridge/src/stdio-proxy.mjs",
    "/absolute/path/to/owner-config.json"
  ]
}
```

The proxy reads the same HTTP/token configuration and forwards requests without spawning Pi, holding a Bridge lock or retrying work. Closing it ends its network waits while the backend and other clients continue. Known backend rejections before admission, such as `UNAUTHORIZED` or `SERVICE_BUSY`, retain their reason and `http_status` with `recovery:"NOT_ADMITTED"`. Network failures and unverified backend responses return `BRIDGE_CONNECTION_LOST` with outcome-unknown guidance. Each proxy allows 16 concurrent forwards; excess requests return `PROXY_BUSY` / `NOT_FORWARDED` without queueing. Notifications receive no JSON-RPC response.

Multiple direct stdio services using the same state directory conflict on the service lock. Use proxies to share one runtime pool.

## Protocol versions

### MCP 2026-07-28

This protocol uses [per-request metadata](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning) rather than an initialize handshake:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "server/discover",
  "params": {
    "_meta": {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
      "io.modelcontextprotocol/clientInfo": {
        "name": "example-client",
        "version": "1.0"
      }
    }
  }
}
```

Version and capabilities are required on every request; clientInfo is optional. `server/discover` returns supported versions and capabilities. Results include `resultType:"complete"` and server identity metadata. Discovery and tools/list return `ttlMs:0` and `cacheScope:"private"`. [Events](events.md) use the same authenticated endpoint and outbound HTTPS delivery.

HTTP requests also require:

| Header                 | Value                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| `MCP-Protocol-Version` | The body's protocol version                                                   |
| `Mcp-Method`           | The body's method                                                             |
| `Mcp-Name`             | `params.name` for tools/call and prompts/get; `params.uri` for resources/read |

Header names are case-insensitive, values case-sensitive. `Mcp-Name` accepts the specified UTF-8 Base64 sentinel encoding. Missing, duplicate or inconsistent required headers return HTTP 400 / JSON-RPC `-32020 HeaderMismatch`.

Unsupported versions return HTTP 400 / `-32022` with `data.supported` and `data.requested`; missing metadata returns 400 / `-32602`; unknown methods return 404 / `-32601`. See the [message schema](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts) and [stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) / [HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http) bindings.

### MCP SDK clients

The pinned SDK supports initialization-based revisions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05` over stdio, plus its Streamable HTTP bindings. SDK clients initialize first and follow SDK header negotiation. HTTP+SSE is not implemented. Both protocol paths use the same current tool schemas and dispatcher.

## Timeouts and disconnects

JSON-RPC IDs identify communication exchanges; reusing one does not deduplicate a mutation. After a lost/unknown result, follow the [API outcome guidance](api.md#sessions-and-mutations). Reconnection neither recovers a lost result nor replays work.

| Budget              | Limit                          | Effect                                                              |
| ------------------- | ------------------------------ | ------------------------------------------------------------------- |
| HTTP headers/upload | 10 / 15 seconds                | Bounds incoming request handling.                                   |
| HTTP response wait  | 35 seconds after parsing       | Returns 504 / `REQUEST_WAIT_EXPIRED`; admitted Pi work continues.   |
| Native/owner ACK    | Internal 5 seconds per request | Does not bound execution or abort admitted work. No tool parameter. |
| Proxy network wait  | 40 seconds                     | Exceeds the backend response wait.                                  |

A client or tunnel may impose a shorter deadline. While the service runs, protocol cancellation, HTTP disconnect and proxy exit suppress replies without cancelling admitted calls or later admitted batch items. On modern stdio, `notifications/cancelled` suppresses that request's subsequent messages. Direct stdio EOF instead shuts down the owned service as described above. Use `stop` to cancel Pi execution and queues.

## Bounds and errors

HTTP bodies and MCP stdio messages are limited to **8 MiB**. JSON-RPC arrays, invalid UTF-8, unsupported HTTP content types/encodings, malformed IDs, duplicate credentials and oversized uploads are rejected before dispatch. HTTP allows 16 concurrent requests/admitted waiters and 32 connections.

The response limit is **256 KiB UTF-8 for the complete JSON-RPC envelope**, including metadata, IDs, escaping and both text/structured representations. Exceptional oversized results become `RESPONSE_TOO_LARGE` with outcome-unknown guidance. JSON and Unicode sequences are never cut to fit.

Read's `max_bytes` instead bounds its complete structured result: default 24000, range 4096–65536. Use [read pagination](reading.md#capacity-and-continuation) for normal history and [batch budgeting](api.md#batch) for combined calls.

HTTP authentication/routing/upload failures use status codes 401, 403, 404, 405, 413, 415 or 503. Protocol failures use JSON-RPC errors; tool validation and business failures use tool errors. Error bodies omit private token/config contents.
