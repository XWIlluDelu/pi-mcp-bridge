# Independent loopback Streamable HTTP

Run Bridge independently of the authenticated access client:

```text
owner-authorized callers -> access client -> 127.0.0.1 HTTP Bridge
                                          -> existing owner or owned RPC
```

```sh
node src/http-server.mjs /absolute/private/owner-config.json
```

Configure the access client to connect to the URL, not spawn a stdio Bridge.
Separate supervision/cgroups keep client exit from terminating Bridge. The
[stdio service kit](README.md) has a different lifetime contract.

## Process and request lifetime

One Bridge holds the owner principal, runtime pool, receipts and state lock.
Each POST gets an MCP server and stateless transport, so duplicate JSON-RPC IDs
across requests cannot share response routing. Run only one Bridge per state
directory; stdio and HTTP cannot share that lock concurrently.

HTTP disconnect does not cancel admitted work, including later batch mutations.
Recover a lost result with the same mutation `request_id`; for send, omit text.
JSON-RPC exchange IDs do not deduplicate mutations. A request lost before admission
may have done nothing, but callers must still recover rather than invent a new ID.

SIGTERM/SIGINT stop admission, end incomplete uploads, drain admitted tool/receipt
work and stop owned runtimes before releasing the lock. External owners remain
running; shutdown does not wait for whole model completions. HTTP lifetime is
independent of stdio closure. Allow the supervisor time for drainage; forced exit
requires owner-confirmed recovery of any remaining state lock.

## Backend authentication

Add to the owner configuration:

```json
"http": {
  "port": 43125,
  "tokenFile": "/absolute/private/backend-header-token"
}
```

Config and token files must be canonical absolute regular files owned by the
current UID, without group/other permissions or symlinks. The token contains
32–256 ASCII `A-Z a-z 0-9 . _ ~ -` characters and optionally one newline.
Provision an unpredictable token outside the checkout; keep it out of URLs, CLI
arguments and transcripts. Restart Bridge to rotate it or change HTTP settings.
Grant changes use the normal owner-file reload path.

Every request requires exactly one matching `X-Pi-Bridge-Token`. Authentication
precedes body parsing. This authenticates the backend client, not individual users:
all admitted callers act as the same owner principal. Restrict the remote audience
to that trust boundary; Pi/model authentication is separate.

## Wire contract and limits

- Bind: IPv4 `127.0.0.1`; Host must be exactly `127.0.0.1:<port>`.
- Origin must be absent; any present Origin is rejected. No CORS allowlist.
- Endpoint: `POST /mcp`; authenticated GET/DELETE/OPTIONS return 405.
- Body: `application/json` with optional UTF-8 charset, no compression or JSON-RPC
  array envelopes. Use the ordered `batch` tool for multi-operation requests.
- Body cap: 8 MiB for fixed-length and chunked uploads. Batch input is bounded to
  6,100,000 serialized characters, ten operations and 100,000 units per prompt.
- Resource caps: 16 active requests and 32 TCP connections, plus upload/header
  timeouts. Structured batch responses remain bounded to 32,768 characters.

The pinned `@modelcontextprotocol/sdk` **1.29.0** supports protocol **2025-11-25**.
Bridge uses `sessionIdGenerator: undefined` and `enableJsonResponse: true`;
clients must still send Accept for both `application/json` and `text/event-stream`.
There is no server session ID or persistent GET/SSE stream. See the
[SDK stateless example](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/src/examples/server/simpleStatelessStreamableHttp.ts).

`tunnel-client` v0.0.16 supports HTTP MCP URLs and
[`mcp.extra_headers` file/env references](https://github.com/openai/tunnel-client/blob/v0.0.16/docs/configuration.md).
Use an owner-private token reference. Verify that selected client's loopback policy,
backend Host, token forwarding and protocol negotiation before deployment.

## Verification

Offline SDK/loopback tests cover authentication, Host/Origin, body limits,
duplicate exchange IDs, lost-response recovery, admitted batch drainage, private
files and an independent HTTP process surviving caller exit. Target deployment
checks cover the actual client/tunnel, audience enforcement, header propagation,
protocol negotiation and supervisor shutdown.
