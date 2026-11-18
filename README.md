# Pi MCP Bridge

Expose native [Pi](https://github.com/earendil-works/pi) sessions through MCP, with owner-controlled permissions and one cooperating writer per session. Local clients use stdio; multiple or remote clients share a loopback HTTP service behind an authenticated tunnel.

[Follow a session](docs/collaboration.md) from dispatch to result, or see the
[tool reference](docs/api.md).

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

Edit `owner.json` using [configure one project](docs/configuration.md#configure-one-project): select the native session storage and project, then add its permission grant. The example denies all operations until you grant them. That guide also explains how storage paths differ from project paths and which directories must be private.

If the target session is already open in Pi, [load its companion](docs/runtime.md#daily-tui-and-ordinary-rpc-registration) before remote control. Bridge can resume an inactive saved session itself. Live operations use the owner's [control capabilities and read contract](docs/architecture.md#component-versions).

For one stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple clients, use the shared HTTP service. Stdio-only clients can connect
through its proxy. [Transport setup](docs/transports.md) covers both.

### Verify the first connection

After your MCP client connects, call these tools with the indicated arguments:

1. `health({})` diagnoses the permission configuration and pending restart settings.
2. `list({})` discovers authorized saved sessions. An empty result can mean no saved sessions or no effective `list` grant; check the configured roots and [permission rules](docs/configuration.md#seven-independent-rights).
3. `read({session_id:"<ID from list>"})` opens recent history without starting a writer. Use the returned Bridge ID, not the native Pi ID or session filename.

These calls verify access to the configured data. To send work, create a session or follow a result, continue with [working with a session](docs/collaboration.md); the [API](docs/api.md) defines the exact arguments and outcomes.

## Native Pi integration

Bridge resumes saved sessions with the owner's native Pi environment. For live
owners, see [companion registration, SDK hosts and terminal handoff](docs/runtime.md).

## Documentation

- [Owner configuration and diagnostics](docs/configuration.md)
- [MCP transports](docs/transports.md)
- [Reading and search](docs/reading.md), [model controls](docs/model-control.md) and [completion events](docs/events.md)
- [Optional integrations](docs/compatibility.md) and [architecture](docs/architecture.md)

## Development

Run `npm test` and `npm run format:check`. See [verification](docs/architecture.md#verification)
for external Pi and optional Herdr coverage.

## License

[MIT](LICENSE).
