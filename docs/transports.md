# MCP transports

Both transports expose the same [public tools](api.md) and enforce the same
[independent permissions](configuration.md#seven-independent-rights).

## Choose a process topology

### One client: direct stdio

Configure a standard MCP command:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/path/to/owner-config.json"]
}
```

The client owns this Bridge process. Closing stdin, SIGINT, or SIGTERM drains
admitted receipts, closes owned RPC processes and releases the Bridge lock.
Attached external Pi instances are disconnected, not terminated. Startup and
shutdown share one cleanup path, including a signal arriving while the owner
lock is being acquired. A crash lock is not silently stolen.

Each line is one UTF-8 JSON-RPC message. Protocol stdout contains no logs.
Input lines are bounded at 8 MiB; an oversized line is rejected and discarded
through its next newline without growing an unbounded buffer.

### Multiple clients: one HTTP Bridge

Start one independent service:

```sh
node /absolute/path/to/pi-mcp-bridge/src/http-server.mjs /absolute/path/to/owner-config.json
```

The configuration's `http` object contains `port` and `tokenFile`. The server
binds **127.0.0.1 only** and exposes **POST /mcp only**. GET, DELETE and OPTIONS
return 405; there is no session endpoint or SSE notification stream.

The owner configuration and token file must be canonical absolute paths,
regular files owned by the service user, and inaccessible to group/others
(mode 0600 is appropriate). Symlink token/config paths are rejected. The token
contains 32–256 characters from `A-Z a-z 0-9 . _ ~ -`; one final newline is
permitted in the file.

Every request must carry `x-pi-bridge-token: TOKEN`. Credential validation uses
a fixed-length digest comparison and happens before parsing the request body.
The backend accepts only its exact `Host: 127.0.0.1:PORT` and rejects every
`Origin` header. Keep these checks behind a tunnel: the tunnel must rewrite
the upstream Host, remove browser Origin rather than expose a browser API, and
inject the private backend token after authenticating its public caller. Do not
expose the loopback service directly or share this token with untrusted callers.
This owner-local token boundary is not an implementation of MCP OAuth.

HTTP clients and tunnel gateways must accept `application/json` and
`text/event-stream` in their Accept header; this backend returns ordinary JSON.
There is no `Mcp-Session-Id`, CORS access or GET/SSE replay endpoint. A service
shutdown drains admitted operations before releasing the runtime and owner lock.
A disconnected client never owns the service lifecycle.

### Multiple stdio-only clients: thin shared proxy

Each MCP client may launch:

```json
{
  "command": "node",
  "args": [
    "/absolute/path/to/pi-mcp-bridge/src/stdio-proxy.mjs",
    "/absolute/path/to/owner-config.json"
  ]
}
```

Start the HTTP service first. The proxy reads the same private HTTP/token
configuration and forwards to its loopback endpoint. It does **not** acquire a
Bridge lock, spawn Pi, retain a work queue or retry requests. All proxies share
the service's single RuntimePool. Closing a proxy aborts its network waits, not
the backend or another client. Network failures return
`BRIDGE_CONNECTION_LOST` with same-request-ID recovery guidance. Each proxy
permits at most 16 concurrent forwards, matching the backend's request cap;
excess requests return `PROXY_BUSY` with `NOT_FORWARDED` and are not queued.
Notifications never receive JSON-RPC responses.

Starting several direct stdio Bridge processes with the same state directory
instead remains an owner-lock conflict; changing state directories is not a
shared-runtime proxy.

## Protocol versions

### MCP 2026-07-28

This is an MCP protocol revision, separate from the Bridge's release number
and owner-configuration format. Its [versioning contract](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning)
and [message schema](https://github.com/modelcontextprotocol/specification/blob/main/schema/2026-07-28/schema.ts)
define per-request metadata. Transport requirements are specified for
[stdio](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio)
and [Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).

Modern requests have **no initialize handshake**. Every request includes
`params._meta`:

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

The protocol version and capabilities are required on every request.
`clientInfo` is recommended, not required. No capability is inferred from a
previous request. `server/discover` returns supported versions and capabilities.
Results carry `resultType: "complete"` and server identity metadata; discovery
and `tools/list` also carry `ttlMs: 0` and `cacheScope: "private"`.
The fixed tool list is deterministic; no subscriptions, elicitation, MRTR input,
logging stream or other optional capabilities are advertised.

Modern HTTP also requires:

| Header                 | Value                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `MCP-Protocol-Version` | Same as the body's protocol metadata                                                     |
| `Mcp-Method`           | Same as `method`                                                                         |
| `Mcp-Name`             | Same as `params.name` for tools/call and prompts/get, or `params.uri` for resources/read |

Header names are case-insensitive; values are case-sensitive. Duplicate,
missing or inconsistent required headers produce HTTP 400, JSON-RPC
`-32020` (HeaderMismatch). `Mcp-Name` supports the specified UTF-8 Base64
sentinel encoding. No tool parameters advertise `x-mcp-header`.

An unsupported version produces HTTP 400 / JSON-RPC `-32022`, with
`data.supported` and `data.requested`. The client selects a supported version;
the server never silently substitutes a modern version. Missing required
metadata produces HTTP 400 / `-32602`. An unknown modern method produces HTTP
404 / `-32601`. These errors identify a modern server for dual-era clients.

### Legacy clients

A separate SDK-backed compatibility path supports handshake-based revisions
`2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05` on stdio.
Legacy HTTP uses the supported Streamable HTTP revisions; old HTTP+SSE is not
implemented. Legacy clients still initialize and receive the redesigned tools,
not the obsolete Bridge API. On stdio, a legacy initialize selects legacy
semantics for subsequent requests without modern metadata. Modern requests can
still be served independently on the same process.

On HTTP, requests without a version header retain compatibility with pre-header
legacy clients. Requests carrying modern metadata always pass modern validation.
The modern adapter and legacy SDK share business schemas and tool dispatch.

## Timeouts, disconnects and receipts

A JSON-RPC `id` identifies **one communication exchange**. A mutation's tool
argument `request_id` identifies **one durable business operation**. Reusing a
JSON-RPC ID on a different HTTP connection does not make work idempotent.

Once a tool is admitted, a lost HTTP response does not replay or roll back it.
Recover a mutation with the **same** business `request_id`, using that
operation's recovery parameters in the [API reference](api.md). A create
receipt preserves an already-created child and its initial-send outcome,
including partial/unknown outcomes. Never replace an unknown operation with a
new ID just to retry. Batch disconnects do not cancel later admitted items;
each item has its normal receipt.

There are distinct time budgets:

- HTTP headers: 10 seconds; request upload: 15 seconds.
- HTTP response wait: 35 seconds after a complete parsed request. Exceeding it
  returns HTTP 504 / `REQUEST_WAIT_EXPIRED`; already-admitted Pi work continues.
- Tool `timeout_ms`: a bounded native acknowledgement wait, not model completion
  or a shell kill deadline.
- Proxy network wait: 40 seconds, exceeding the backend response wait.

A tunnel/client can impose a shorter deadline. Query the existing receipt after
reconnecting; no SSE Last-Event-ID recovery or hidden work replay is implemented.
Protocol cancellation aborts request-related reads/waits, not Pi execution.
Use `stop` for execution and queue cancellation.
On modern stdio, `notifications/cancelled` suppresses subsequent messages for
that request. This server uses JSON HTTP responses, not SSE response streams.

## Bounds and errors

HTTP bodies and stdio input messages are bounded at 8 MiB. JSON-RPC arrays,
invalid UTF-8, unsupported HTTP content types/encodings, malformed IDs, duplicate
credentials and oversized uploads are rejected before dispatch. HTTP allows at
most 16 concurrent requests/admitted waiters and 32 connections. Responses use
`Cache-Control: no-store`.

The global response limit is **256 KiB UTF-8 for the entire JSON-RPC envelope**,
including metadata, request ID, text encoding/escaping and structured content.
The server never cuts JSON or splits a Unicode sequence. Oversized exceptional
results become an explicit `RESPONSE_TOO_LARGE` tool error with recovery
guidance, rather than silently dropping a mutation's status or replaying work.
Read selection and continuations handle normal history pagination. Read's
`max_bytes` counts its complete structured JSON result (default 24,000 bytes,
allowed 4,096–65,536), including read metadata; it is distinct from the global
MCP envelope cap. The envelope cap includes both representations if present.

HTTP authentication/routing/upload failures use clear status codes (401, 403,
404, 405, 413, 415, 503). Modern protocol failures use the specified JSON-RPC
error codes; tool validation and business failures are returned as tool errors.
Error bodies never include private token/config contents.
