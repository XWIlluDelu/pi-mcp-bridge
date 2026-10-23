# Pi MCP Bridge

Expose native [Pi](https://github.com/earendil-works/pi) sessions to other agents through MCP, with owner-controlled permissions and one cooperating writer per session. Local clients use stdio; remote clients use a loopback HTTP service behind an authenticated tunnel.

## What it does

- **Inspect:** list authorized sessions with title, project, activity and coarse status. Read native context as a prompt-linked timeline, starting with the latest prompt and its assistant text/thinking; selectors add earlier prompts, summaries, tools or commands. Explicit `view:"observed"` reads a captured request-stage context, including observed memory transforms, with capture time and freshness metadata. It is not the final provider payload. Both views page backwards from the newest selected content; [reading](docs/reading.md) defines selection and retention.
- **Send:** submit text and/or images with default, idle-only, steer or follow-up delivery, or run native Pi `!` commands through the separate `command` tool.
- **Control:** discover native configured models independently of sessions, set a session's model and thinking level, compact context (idle by default). Owned RPCs release safely between tasks and cold-resume when later work needs them. Stop execution and withdraw queued input, returning a single bounded text prefix with an explicit incompleteness flag when cut short.
- **Manage:** create a session and send its initial prompt, optionally forking a parent's current committed branch without switching its running instance. Recoverably delete sessions while retaining project files.
- **Notify:** subscribe to a known Bridge-owned session's completion through [MCP Events](docs/events.md). ChatGPT Work chats/dots receive a signed webhook and can read that round's result in the original chat.
- **Batch:** run 1–10 operations, serially per session and concurrently across independent sessions.
- **Permissions:** seven independent permissions at default, project and session tiers; `health` reports unusual combinations without changing them.

## Start locally

Requires Linux, Node.js 22.19 or later, and your own Pi installation (tested with Pi 1.4.0). Process-identity and Unix-socket ownership coordination are Linux-specific. `piExecutable` selects an absolute Pi CLI path; otherwise the launch environment's PATH selects `pi`. CLI execution, history parsing/projection/fork and model APIs all use that same installation. Bridge has no Pi dependency or fallback installation.

```sh
command -v pi
pi --version
npm ci
mkdir -p -m 700 /absolute/private/path
cp deploy/owner.example.json /absolute/private/path/owner.json
chmod 600 /absolute/private/path/owner.json
```

Replace every example path and add only the grants you intend. The example denies every operation until you grant it.

Bridge state and IPC directories must be canonical, user-owned and private. Native session storage follows Pi's umask: 0755 directories below a private ancestor are supported without chmod. The Bridge checks native path/file integrity separately and rejects replaceable storage rather than repairing permissions. See [storage requirements](docs/configuration.md#storage-and-project-paths). Startup performs these checks directly.

For a single stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple clients, start one shared HTTP service; each stdio-only client can run `src/stdio-proxy.mjs` against it. See [transport setup](docs/transports.md) for the token, tunnel, protocol versions, timeouts and connection recovery.

### Tools at a glance

| Tool        | Main arguments                                                              | Permission                                                                                              |
| ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `list`      | Optional project/name/time/ID filters; offset/limit                         | `list` per returned session                                                                             |
| `read`      | `session_id`; optional view/preset/select/cursor/max_bytes                  | `read`                                                                                                  |
| `models`    | Optional offset/limit; returns models/next_offset                           | Effective `send`/`command`/`create` on a configured project, or `send`/`command` on an in-scope session |
| `set_model` | `session_id`; model and/or thinking_level; busy supported                   | `send`                                                                                                  |
| `compact`   | `session_id`; optional instructions/interrupt                               | `send`; explicit interrupt also `stop`                                                                  |
| `send`      | `session_id`, text/images; optional mode/model/thinking_level               | `send`                                                                                                  |
| `command`   | `session_id`, `command`                                                     | `command`                                                                                               |
| `stop`      | `session_id`                                                                | `stop` only                                                                                             |
| `create`    | `project`, text and/or images; optional name/fork_from/model/thinking_level | Target `create`; source `read` for fork                                                                 |
| `delete`    | `session_id`                                                                | `delete`                                                                                                |
| `batch`     | 1–10 `{op,args}` items                                                      | Each wrapped operation's own permission                                                                 |
| `health`    | Optional known `session_id`; permissions by default                         | Issues only; does not change grants                                                                     |

`models` lists the native agent-configuration catalog without loading sessions or extensions. Current session model/thinking belongs to `list.status`; `set_model` changes that selection without a prompt and returns its actual model and thinking level. `list.creatable_projects` discovers configured projects with project-level list and create permission, including empty projects, independently of session filters and pagination. Known hidden destinations can still be used with create permission.

Every mutation call is a new operation, without caller-generated IDs or a result lookup API. Identical calls are not deduplicated. Send returns one of `started`, `queued`, `handled`, `skipped`, `rejected`, or `unknown`, not model completion. After a lost or unknown result, inspect `list/read` before deciding whether to submit again; never automatically replay work. Command and stop return bounded output prefixes with explicit completeness flags, without continuation. See [API](docs/api.md) and [reading](docs/reading.md).

## Native Pi integration

Cold resume uses the user's own Pi settings, authentication, tools, extensions and project configuration; isolation is opt-in (the tests use it).

For ordinary `pi` and RPC-host launches to participate, [add the companion to native Pi settings](docs/runtime.md#daily-tui-and-ordinary-rpc-registration). It reads the existing private owner configuration and registers only its session roots; grants remain unchanged. Newly configured extensions do not attach to already-running processes automatically.

To open a Bridge-owned session in an interactive native TUI:

```sh
node src/open.mjs /absolute/private/path/owner.json ps_SESSION_ID
```

The launcher starts a fresh TUI, negotiates the current owner's shutdown, waits for admitted work and a normal EOF exit, then switches to the saved session. The session file is not opened before negotiation. Ordinary TUI/RPC instances participate by loading the companion extension. See [runtime integration](docs/runtime.md).

The optional global [`herdr` switch](docs/configuration.md#herdr-process-placement) places new RPC writers in local Herdr, including cold resumes. It hot-updates without moving existing writers; connected owners are reused first.

Bridge-owned prompt runtimes also release normally after their run and queues finish and idle is proven. Saved history remains available; the next send can resume the session. Unconfirmed work stays owned, and external TUI/RPC hosts manage their own lifecycle.

**Native boundaries:**

- An unregistered RPC process cannot be attached to by PID.
- The companion supports reading, live model/thinking metadata, standalone `set_model` and text/images. Explicit interrupting compaction is supported; remote command, stop and prompt settings require stronger control; see the [capability table](docs/runtime.md#runtime-capabilities).
- Closing a native TUI interrupts its running task; it does not transfer that task to a background process. After a graceful close, cold resume is allowed only once exact process death is established.
- Host applications with their own controller can supply native capabilities.

## Documentation

- [Configuration and permissions](docs/configuration.md)
- [API and timeout behavior](docs/api.md)
- [Model catalog, thinking and compaction](docs/model-control.md)
- [Context selection, pagination and live observation](docs/reading.md)
- [Runtime ownership, TUI handoff and capabilities](docs/runtime.md)
- [MCP protocols and transports](docs/transports.md)
- [Completion events and ChatGPT acceptance](docs/events.md)
- [Architecture and verification](docs/architecture.md)

## Development

```sh
npm test
npm run format:check
npm audit
```

Tests use synthetic providers, temporary session stores and isolated Pi profiles, without production sessions, credentials, deployments or paid model calls. Native subprocess/PTY tests need Linux utilities including `script`; the service-unit check needs `systemd-analyze`.
