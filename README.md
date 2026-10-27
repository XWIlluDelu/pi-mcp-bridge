# Pi MCP Bridge

Expose native [Pi](https://github.com/earendil-works/pi) sessions through MCP, with owner-controlled permissions and one cooperating writer per session. Local clients use stdio; multiple or remote clients share a loopback HTTP service behind an authenticated tunnel.

## What it does

- List authorized sessions, read recent turns in source order, search effective context and expand referenced messages or evidence.
- Read native Session Context, captured Runtime Context or explicitly enabled extension readers.
- Send text and images, run native shell commands, select model/thinking settings, compact context, reload idle sessions and stop work.
- Create or fork saved sessions, optionally sending a first task, and move deleted sessions to recoverable trash while retaining project files.
- Notify ChatGPT Work chats and dots when an owned RPC or connected TUI/RPC companion settles, with a short result excerpt and pinned native reading arguments.
- Batch independent operations and apply seven separate permissions at default, project and session tiers.

See [working with a session](docs/collaboration.md) for the dispatch, observation and continuation workflow, and the [public API](docs/api.md) for tool arguments and outcomes.

## Start locally

Requires Linux, Node.js 22.19 or later, and your own Pi installation (tested with Pi 1.4.0). Install and configure Pi first; Bridge uses that installation's CLI, SDK and native authentication. Set `piExecutable` to an absolute Pi CLI path, or let the launch environment's PATH select `pi`.

Get the source and prepare an owner configuration. Use absolute paths below, replacing the private directory with your chosen location:

```sh
command -v pi
pi --version
git clone https://github.com/XWIlluDelu/pi-mcp-bridge.git
cd pi-mcp-bridge
npm ci
mkdir -p -m 700 /absolute/private/path
cp deploy/owner.example.json /absolute/private/path/owner.json
chmod 600 /absolute/private/path/owner.json
```

Edit `owner.json` using [configure one project](docs/configuration.md#configure-one-project): select the native session storage and project, then add its permission grant. The example denies all operations until you grant them. That guide also explains how storage paths differ from project paths and which directories must be private.

If the target session is already open in Pi, [load its companion](docs/runtime.md#daily-tui-and-ordinary-rpc-registration) before remote control. Bridge can resume an inactive saved session itself. Use matching Bridge control components; live reads follow the independent [read contract](docs/architecture.md#component-versions).

For one stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple clients, start one HTTP service and use `src/stdio-proxy.mjs` for stdio-only clients. [Transport setup](docs/transports.md) covers tokens, tunnels and protocol versions.

### Verify the first connection

After your MCP client connects, call these tools with the indicated arguments:

1. `health({})` diagnoses the permission configuration and pending restart settings.
2. `list({})` discovers authorized saved sessions. An empty result can mean no saved sessions or no effective `list` grant; check the configured roots and [permission rules](docs/configuration.md#seven-independent-rights).
3. `read({session_id:"<ID from list>"})` opens recent history without starting a writer. Use the returned Bridge ID, not the native Pi ID or session filename.

These calls verify access to the configured data. To send work, create a session or follow a result, continue with [working with a session](docs/collaboration.md); the [API](docs/api.md) defines the exact arguments and outcomes.

## Native Pi integration

Cold resume uses the owner's native settings, authentication, tools, extensions and project configuration. Bridge-owned RPCs release when their work is safely idle and resume saved sessions for later work.

[Load the companion](docs/runtime.md#daily-tui-and-ordinary-rpc-registration) to register ordinary TUI/RPC owners. Use [`reload({session_id})`](docs/api.md#reload) to apply resource changes to an idle owner. To open a Bridge session in a native TUI:

```sh
node src/open.mjs /absolute/private/path/owner.json ps_SESSION_ID
```

The launcher negotiates ownership before opening the session. See [runtime integration](docs/runtime.md) for handoff, host capabilities and lifecycle constraints, including the effect of closing an active TUI. The optional [Herdr switch](docs/configuration.md#herdr-process-placement) places new owned RPC writers in local Herdr.

## Documentation

| When you need to…                                               | Start here                                                                             |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Choose accessible projects and operations                       | [Configuration and permissions](docs/configuration.md)                                 |
| Connect one client, share a service or expose a remote endpoint | [MCP transports](docs/transports.md)                                                   |
| Dispatch work and understand the result                         | [Working with a session](docs/collaboration.md), then the [API reference](docs/api.md) |
| Find history, expand evidence or choose a context source        | [Reading and search](docs/reading.md)                                                  |
| Change models, thinking effort or context size                  | [Model control](docs/model-control.md)                                                 |
| Receive completion notifications                                | [Events](docs/events.md)                                                               |
| Connect a live Pi owner or integrate an SDK/RPC host            | [Runtime integration](docs/runtime.md)                                                 |
| Enable an optional plugin reader or input mapping               | [Compatibility modules](docs/compatibility.md)                                         |
| Investigate a failed request or service operation               | [Diagnostics](docs/configuration.md#diagnostics)                                       |
| Develop or verify Bridge                                        | [Architecture and verification](docs/architecture.md)                                  |

## Development

```sh
npm test
npm run format:check
npm audit
```

Tests use synthetic providers, temporary session stores and isolated Pi profiles. See [verification](docs/architecture.md#verification) for required Linux utilities, external Pi selection and optional Herdr tests.

## License

[MIT](LICENSE).
