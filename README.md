# Pi MCP Bridge

Expose native [Pi](https://github.com/earendil-works/pi) sessions to other agents through MCP, with owner-controlled permissions and one cooperating writer per session. Local clients use stdio; remote clients use a loopback HTTP service behind an authenticated tunnel.

## What it does

- **Inspect:** list authorized sessions with title, project, activity and coarse status. Read the effective native context as a chronological, prompt-linked timeline, selecting summaries, prompts, text, thinking, tools and commands. Pages start with the newest selected content and continue backwards.
- **Send:** submit text and/or images with default, idle-only, steer or follow-up delivery, or run native Pi `!` commands through the separate `command` tool.
- **Control:** discover runtime-available models, set a session's model and thinking level, compact context (idle by default), or reopen an idle owned RPC. Stop execution and withdraw queued input, with its complete text available in pages.
- **Manage:** create a session and send its initial prompt, optionally forking a parent's current committed branch without switching its running instance. Recoverably delete sessions while retaining project files.
- **Batch:** run 1–10 operations, serially per session and concurrently across independent sessions.
- **Permissions:** seven independent permissions at default, project and session tiers; `health` reports unusual combinations without changing them.

## Start locally

Requires Linux and Node.js 22.19 or later; process-identity and Unix-socket ownership coordination are Linux-specific. The pinned native baseline is Pi 1.1.0; `piExecutable` can select another compatible executable.

```sh
npm ci
mkdir -p -m 700 /absolute/private/path
cp deploy/owner.example.json /absolute/private/path/owner.json
chmod 600 /absolute/private/path/owner.json
```

Replace every example path and add only the grants you intend. The example denies every operation until you grant it.

Review existing `sessionRoots`, `stateDir` and `attachmentDir` directories: they must be owned by the service user, canonical (not symlink aliases), and private. Pi can create session directories as **0755** under a normal umask; Bridge requires no group/other access. After reviewing the selected existing directories, the owner can use `chmod 700 /absolute/path/to/selected/directory`. Apply it only to those directories, not recursively to all Pi data. See [storage requirements](docs/configuration.md#storage-and-project-paths).

Then run the read-only preflight:

```sh
node deploy/check-owner.mjs /absolute/private/path/owner.json
```

For a single stdio MCP client:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/pi-mcp-bridge/src/server.mjs", "/absolute/private/path/owner.json"]
}
```

For multiple clients, start one shared HTTP service; each stdio-only client can run `src/stdio-proxy.mjs` against it. See [transport setup](docs/transports.md) for the token, tunnel, protocol versions, timeouts and connection recovery.

### Tools at a glance

| Tool        | Main arguments                                                       | Permission                              |
| ----------- | -------------------------------------------------------------------- | --------------------------------------- |
| `list`      | Optional project/name/time/ID filters; offset/limit                  | `list` per returned session             |
| `read`      | `session_id`; optional preset/select/cursor/max_bytes                | `read`                                  |
| `models`    | Known `session_id`; optional start/offset/limit                      | `send`                                  |
| `set_model` | `session_id`, `request_id`, model and/or thinking_level              | `send`                                  |
| `compact`   | `session_id`, `request_id`; optional instructions/interrupt          | `send`; explicit interrupt also `stop`  |
| `reload`    | `session_id`, `request_id`; idle owned RPC reopen                    | `send`                                  |
| `send`      | `session_id`, `request_id`, text/images; optional mode/model         | `send`                                  |
| `command`   | `session_id`, `request_id`, `command`                                | `command`                               |
| `stop`      | `session_id`, `request_id`                                           | `stop` only                             |
| `create`    | `project`, `request_id`, text and/or images; optional name/fork_from | Target `create`; source `read` for fork |
| `delete`    | `session_id`, `request_id`                                           | `delete`                                |
| `batch`     | 1–10 `{op,args}` items                                               | Each wrapped operation's own permission |
| `health`    | Optional known `session_id`; permissions by default                  | Diagnostics; does not change grants     |

Every mutation requires a `request_id`. Native acceptance is not model completion, and a timeout can leave the outcome `unknown`: recover using the same `request_id` rather than submitting the work again. See [API](docs/api.md) and [reading](docs/reading.md).

## Native Pi integration

Cold resume uses the user's own Pi settings, authentication, tools, extensions and project configuration; isolation is opt-in (the tests use it).

To open a Bridge-owned session in an interactive native TUI:

```sh
node src/open.mjs /absolute/private/path/owner.json ps_SESSION_ID
```

The launcher starts a fresh TUI, negotiates the current owner's shutdown, waits for admitted work and a normal EOF exit, then switches to the saved session. The session file is not opened before negotiation. Ordinary TUI/RPC instances participate by loading the companion extension. See [runtime integration](docs/runtime.md).

**Native boundaries:**

- An unregistered RPC process cannot be attached to by PID.
- The companion supports reading, text/images and standalone model/thinking settings. Remote command, stop, compact, reload and combined prompt+model require stronger control; see the [capability table](docs/runtime.md#runtime-capabilities).
- Closing a native TUI interrupts its running task; it does not transfer that task to a background process. After a graceful close, cold resume is allowed only once exact process death is established.
- Host applications with their own controller can supply native capabilities.

## Documentation

- [Configuration and permissions](docs/configuration.md)
- [API and recovery contracts](docs/api.md)
- [Runtime models, thinking, compaction and reload](docs/model-control.md)
- [Context selection, pagination and live observation](docs/reading.md)
- [Runtime ownership, TUI handoff and capabilities](docs/runtime.md)
- [MCP protocols and transports](docs/transports.md)
- [Architecture and verification](docs/architecture.md)

## Development

```sh
npm test
npm run format:check
npm audit
```

Tests use synthetic providers, temporary session stores and isolated Pi profiles, without production sessions, credentials, deployments or paid model calls. Native subprocess/PTY tests need Linux utilities including `script`; the service-unit check needs `systemd-analyze`.
