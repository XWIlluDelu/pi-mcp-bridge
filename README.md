# Pi MCP Bridge

Expose native [Pi](https://github.com/earendil-works/pi) sessions through MCP, with owner-controlled permissions and one cooperating writer per session. Local clients use stdio; multiple or remote clients share a loopback HTTP service behind an authenticated tunnel.

## What it does

- List authorized sessions, read useful task overviews, search effective context and expand referenced evidence.
- Read native Session Context, captured Runtime Context or explicitly enabled extension readers.
- Send text and images, run native shell commands, select model/thinking settings, compact context and stop work.
- Create or fork sessions, and move deleted sessions to recoverable trash while retaining project files.
- Notify ChatGPT Work chats and dots when a Bridge-owned session settles, with a short result excerpt and pinned native reading arguments.
- Batch independent operations and apply seven separate permissions at default, project and session tiers.

Every mutation call performs a new operation. Send/create return a `submission_id` for querying admission receipts, including late native ACKs. External owners report confirmed dispatch separately from unobservable native admission. These receipts are not model completion or retry keys; automatic retries can duplicate work. Use `list/read` for activity and results. See the [public API](docs/api.md) and [collaboration design](docs/collaboration.md).

## Start locally

Requires Linux, Node.js 22.19 or later, and your own Pi installation (tested with Pi 1.4.0). Set `piExecutable` to an absolute Pi CLI path, or let the launch environment's PATH select `pi`. CLI execution and SDK operations use that same installation.

```sh
command -v pi
pi --version
npm ci
mkdir -p -m 700 /absolute/private/path
cp deploy/owner.example.json /absolute/private/path/owner.json
chmod 600 /absolute/private/path/owner.json
```

Replace the example paths and grant the operations you need; the example denies all operations. Bridge state and IPC directories must be canonical, user-owned and private. Native session storage has separate [path-integrity requirements](docs/configuration.md#storage-and-project-paths) and supports Pi's ordinary permissions.

For one stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple clients, start one HTTP service and use `src/stdio-proxy.mjs` for stdio-only clients. [Transport setup](docs/transports.md) covers tokens, tunnels and protocol versions.

## Native Pi integration

Cold resume uses the owner's native settings, authentication, tools, extensions and project configuration. Bridge-owned RPCs release when their work is safely idle and resume saved sessions for later work.

[Load the companion](docs/runtime.md#daily-tui-and-ordinary-rpc-registration) to register ordinary TUI/RPC owners. New extension settings take effect when loaded by the running process. To open a Bridge session in a native TUI:

```sh
node src/open.mjs /absolute/private/path/owner.json ps_SESSION_ID
```

The launcher negotiates ownership before opening the session. See [runtime integration](docs/runtime.md) for handoff, host capabilities and lifecycle constraints, including the effect of closing an active TUI. The optional [Herdr switch](docs/configuration.md#herdr-process-placement) places new owned RPC writers in local Herdr.

## Documentation

- [Configuration and permissions](docs/configuration.md)
- [Public tool API](docs/api.md)
- [Model catalog, thinking and compaction](docs/model-control.md)
- [Reading, search and reference expansion](docs/reading.md)
- [Optional compatibility modules](docs/compatibility.md)
- [Runtime ownership and host interfaces](docs/runtime.md)
- [MCP protocols and transports](docs/transports.md)
- [Completion events](docs/events.md)
- [Architecture and verification](docs/architecture.md)

## Development

```sh
npm test
npm run format:check
npm audit
```

Tests include independent modules under `integrations/` and use synthetic providers, temporary session stores and isolated Pi profiles. Native subprocess/PTY tests require Linux utilities including `script`; the service-unit check needs `systemd-analyze`. See [verification](docs/architecture.md#verification) for external Pi selection and optional Herdr tests.
