# Pi MCP Bridge

Expose native local [Pi](https://github.com/earendil-works/pi) coding-agent sessions to external MCP agents (such as ChatGPT/Dot, Claude/Duet, Grok, or local MCP clients) with owner-controlled permissions and single-writer safety.

## Core design

1. **Low-burden MCP tool design** ([tool reference](docs/api.md), [reading & search](docs/reading.md)): Coarse tools let external agents discover sessions (`list`, `models`), navigate and search context on demand (`read`, `search` with refs and cursors), and drive sessions (`create`, `send`, `set_model`, `command`, `stop`, `compact`, `reload`, `delete`, `batch`) without dumping full transcripts into context.
2. **Pluggable extension compatibility** ([integrations](docs/compatibility.md)): Pi extensions that reshape context or memory (such as [Magic Context](integrations/magic-context/README.md) and [Intercom](integrations/intercom/README.md)) live under `integrations/` and are enabled explicitly via `compatibilityModules`. Bridge core does not depend on any specific Pi extension.
3. **Atomic, inherited permissions** ([owner configuration](docs/configuration.md#seven-independent-rights)): Seven independent rights (`list`, `read`, `send`, `command`, `stop`, `create`, `delete`) resolve as `session > most-specific project > default` (deny by default). Unusual combinations (such as `send:true, read:false`) are flagged by `health` sanity checks rather than blocked.

Transports, single-writer ownership, IPC coordination, and completion webhooks are supporting runtime details documented separately below.

## Start locally

Requires Linux, Node.js 22.19 or later, and your own Pi installation. Install and configure Pi first; Bridge uses that installation's CLI, SDK and native authentication. Both npm installations and Pi's official managed installer are supported. Set `piExecutable` to an absolute Pi CLI or managed-launcher path, or let the launch environment's PATH select `pi`. See [native environment](docs/configuration.md#native-environment) for installation selection.

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

In `owner.json`, set the native storage roots, project directory and permission grant. The example denies all operations until you grant them. See [configure one project](docs/configuration.md#configure-one-project).

If the target session is already open in Pi, [load its companion](docs/runtime.md#daily-tui-and-ordinary-rpc-registration) before remote control. Bridge can resume an inactive saved session itself. Live operations use the owner's [control capabilities and read contract](docs/architecture.md#component-versions).

For one stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple or remote clients, use the shared loopback HTTP service behind an authenticated tunnel; stdio-only clients can connect through its proxy. [Transport setup](docs/transports.md) covers both.

### Verify the first connection

After your MCP client connects, call these tools with the indicated arguments:

1. `health({})` diagnoses the permission configuration and pending restart settings.
2. `list({})` discovers authorized saved sessions. An empty result can mean no saved sessions or no effective `list` grant; check the configured roots and [permission rules](docs/configuration.md#seven-independent-rights).
3. `read({session_id:"<ID from list>"})` opens recent history without starting a writer. Use the returned Bridge ID, not the native Pi ID or session filename.

If you are starting with an empty session store and have `create` permission,
call `create({project:"<path from list.creatable_projects>"})` to create a saved
session. With a `send` grant, submit a prompt to that session and use `list` or
`read` to follow its progress. See [the calling workflow](docs/api.md#calling-workflow).

## Documentation

### Core design & usage

- [Public tool API & calling workflow](docs/api.md) — all MCP tools, admission statuses, and end-to-end session flow
- [Reading and search](docs/reading.md) — turn ranges, content kinds, refs, cursors, and budgets
- [Owner configuration and permissions](docs/configuration.md) — setup, `owner.json` schema, 7 independent rights, and TUI menu
- [Optional plugin compatibility modules](docs/compatibility.md) — external module lifecycle, input mappings, and session readers

### Controls, transports & events

- [Model discovery and native controls](docs/model-control.md) — `models`, `set_model`, prompt settings, and `compact`
- [MCP transports](docs/transports.md) — stdio, loopback HTTP service, stdio proxy, and wire bounds
- [Completion events](docs/events.md) — `session.settled` signed HTTPS webhooks (OpenAI MCP Events)

### Architecture & runtime internals

- [Architecture and module map](docs/architecture.md) — system layout, `src/` directory map, invariants, and verification
- [Native runtime, ownership and local entry](docs/runtime.md) — single-writer registry, TUI companion, handoff, shutdown, and host bindings

## Development

Run `npm test` and `npm run format:check`. See [verification](docs/architecture.md#verification)
for external Pi and optional Herdr coverage.

## License

[MIT](LICENSE).
