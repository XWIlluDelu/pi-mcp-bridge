# Pi MCP Bridge

Expose native local [Pi](https://github.com/earendil-works/pi) coding-agent sessions to external MCP agents (ChatGPT/Dots, Claude Desktop/Code/Duet, Cursor, Grok, or Pi itself) with owner-controlled permissions, low-token tool design, and single-writer safety on **Linux and macOS**.

```text
ChatGPT / Dots (MCP 2026-07-28 + webhooks) ──HTTP──┐
                                                   ▼
Claude / Cursor / Grok (MCP 2025-11-25) ──stdio─► Pi MCP Bridge (13 layered tools, 7-right policy)
                                                   │
                 ┌─────────────────────────────────┼────────────────────────────────┐
                 ▼                                 ▼                                ▼
      Bridge-owned Pi RPC                 Live Pi TUI Companion           External Extension Modules
  (cold-start / Herdr on Linux)      (share active terminal + /bridge-join)  (Magic Context, Intercom…)
```

## Why Pi MCP Bridge?

Most coding-agent MCP wrappers are stateless CLI spawners that dump full transcripts into context and cannot coexist with a live terminal session. Pi MCP Bridge instead gives external agents:

1. **Layered, low-burden MCP surface (13 compact tools)** ([API reference](docs/api.md), [reading & search](docs/reading.md)): Clear separation between **session lifecycle** (`list_sessions`, `create_session`, `update_session`, `maintain_session`, `delete_session`), **in-session interaction** (`read`, `send`, `command`, `stop`, `submission`), and **Bridge-level utilities** (`models`, `batch`, `health`).
2. **Cooperating single-writer runtime** ([runtime](docs/runtime.md)): Seamlessly coordinates cold-started Bridge RPC workers, live Pi TUI/RPC sessions via companion extension (including remote `stop` and `/bridge-join` terminal handoff), optional [Herdr](docs/configuration.md#herdr-process-placement) placement on Linux, and SDK/RPC hosts.
3. **Zero-coupling external extension modules** ([integrations](docs/compatibility.md)): Community Pi extensions that reshape context or memory (such as [Magic Context](integrations/magic-context/README.md), [Intercom](integrations/intercom/README.md), or observational-memory plugins) plug in via standalone external ESM modules (`compatibilityModules`) with zero imports from Bridge internals and automatic multi-reader composition.
4. **Atomic, inherited permissions** ([configuration](docs/configuration.md#seven-independent-rights)): Seven independent rights (`list`, `read`, `send`, `command`, `stop`, `create`, `delete`) resolve as `session > most-specific project > default` (deny by default).

## Client & protocol compatibility

Bridge automatically serves **both** modern stateless MCP and standard initialize-based MCP on the same stdio and HTTP endpoints:

| Client / Ecosystem                             | MCP Protocol                               | Transport                   | Completion notification                                       |
| ---------------------------------------------- | ------------------------------------------ | --------------------------- | ------------------------------------------------------------- |
| ChatGPT / OpenAI Dots                          | `2026-07-28` (`server/discover`)           | HTTP (behind tunnel)        | `session.settled` webhooks + `wait_ms`                        |
| Claude Desktop / Code / Cursor / Grok / Pi MCP | `2025-11-25` … `2024-11-05` (`initialize`) | stdio, HTTP, or stdio proxy | `send` / `create_session` / `list_sessions` bounded `wait_ms` |

## Quick start (Linux & macOS)

Requires **Linux or macOS**, **Node.js 22.19+**, and an existing [Pi](https://github.com/earendil-works/pi) installation (npm or official managed installer).

```sh
git clone https://github.com/XWIlluDelu/pi-mcp-bridge.git
cd pi-mcp-bridge
npm ci

# Generate owner.json for your current project and verify your environment:
node bin/pi-mcp-bridge.mjs init --project /absolute/path/to/your/project
node bin/pi-mcp-bridge.mjs doctor
```

`init` creates a private `~/.config/pi-mcp-bridge/owner.json` (`0600`), prints the exact JSON snippet for your MCP client (Claude Desktop, Claude Code, Cursor, etc.), and optionally sets up an HTTP port and `0600` token with `--http-port 43123`.

To also control sessions you already have open in Pi TUI, register the companion extension in `~/.pi/agent/settings.json`:

```json
{
  "extensions": ["/absolute/path/to/pi-mcp-bridge/src/attach-extension.mjs"]
}
```

### Verify the first connection

After your MCP client connects:

1. `health({})` confirms your permission policy and event store.
2. `list_sessions({})` discovers authorized sessions with status, model, `context_usage`, capabilities, and `creatable_projects`.
3. `read({session_id:"<ID from list_sessions>"})` opens the last three turns without starting Pi.
4. `send({session_id:"<ID>", text:"Summarize the repo", wait_ms: 20000})` submits work and optionally waits up to 20s for settlement (for non-webhook clients).

## CLI commands

```sh
pi-mcp-bridge init [owner.json] [--project DIR] [--http-port PORT] [--allow-command] [--allow-delete]
pi-mcp-bridge doctor [owner.json] [--json]
pi-mcp-bridge stdio <owner.json>
pi-mcp-bridge http <owner.json>
pi-mcp-bridge proxy <owner.json>
pi-mcp-bridge open <owner.json> <session_id>
pi-mcp-bridge release <owner.json> <session_id> [--interrupt]
pi-mcp-bridge reset <owner.json> <session_id> --confirm-local-closed
```

Direct `node src/server.mjs` and `node src/http-server.mjs` entry points remain unchanged for existing setups and systemd units.

## Documentation

### Core design & usage

- [Public tool API & calling workflow](docs/api.md) — all 13 MCP tools, `wait_ms`, admission statuses, and end-to-end flow
- [Reading and search](docs/reading.md) — turn ranges, content kinds, refs, image blocks, cursors, and budgets
- [Owner configuration and permissions](docs/configuration.md) — setup, `owner.json` schema, 7 independent rights, and TUI menu
- [External compatibility modules](docs/compatibility.md) — standalone plugin contract, input mappings, and composable session readers

### Controls, transports & events

- [Model discovery and native controls](docs/model-control.md) — `models`, `update_session`, prompt settings, and `maintain_session`
- [MCP transports](docs/transports.md) — `2026-07-28` + `2025-11-25`..`2024-11-05`, stdio, HTTP service, and stdio proxy
- [Completion events](docs/events.md) — `session.settled` signed HTTPS webhooks (OpenAI MCP Events)

### Architecture & runtime internals

- [Architecture and module map](docs/architecture.md) — system layout, `src/` map, invariants, and verification
- [Native runtime, ownership and local entry](docs/runtime.md) — single-writer registry (Linux & macOS), TUI companion, handoff, and host bindings

## Development

```sh
npm test
npm run format:check
```

See [verification](docs/architecture.md#verification) for external Pi and optional Herdr coverage.

## License

[MIT](LICENSE).
