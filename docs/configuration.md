# Owner configuration and permissions

Use a private canonical JSON file. [The example](../deploy/owner.example.json) denies every operation. Replace its paths with directories you explicitly intend the Bridge to access. When only some projects are authorized, configure those projects' session roots rather than a broad parent.

## Settings

Only the fields below are accepted. Unknown fields and incomplete baseline permissions are rejected. Project and session grants can override subsets of their applicable rights.

| Key                       | Meaning                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `principal`               | Stable caller/receipt namespace. One service uses one policy identity.                                                        |
| `stateDir`                | Private Bridge state: receipts, lock and recoverable trash.                                                                   |
| `sessionRoots`            | Nonempty array of absolute native session storage directories.                                                                |
| `folders`                 | Authorized configuration scope, each `{id,path}`; `path` is the absolute project cwd. Inclusion alone grants nothing.         |
| `defaults`                | Required baseline with all seven permission keys. Each value is boolean or `null`; `null` denies at this scope.               |
| `grants`                  | Project/session permission overrides.                                                                                         |
| `attachmentDir`           | Optional shared private registry directory; every cooperating owner must use the same canonical directory.                    |
| `attachmentExitTimeoutMs` | Optional 50–30000 ms owner-exit verification budget.                                                                          |
| `piExecutable`            | Optional absolute path to your Pi executable; otherwise resolved from the child environment's PATH, never the SDK dependency. |
| `piArgs`                  | Optional additional native CLI arguments; the launcher and runtime reject incompatible ownership/selection flags.             |
| `piRuntime`               | Explicit launch overrides, described below.                                                                                   |
| `http`                    | Optional `{port,tokenFile}`; required for HTTP/proxy entry points.                                                            |

### Storage and project paths

- Storage roots and state must not overlap or resolve through directory aliases. Session-file symlinks and hardlink aliases are rejected.
- Existing `sessionRoots`, `stateDir` and `attachmentDir` directories must belong to the service user and have no group/other permissions. Pi's default directory creation follows the process umask, so a native session directory can be 0755. Before using it, review its sharing requirements and, if appropriate, apply `chmod 700` to that selected directory. Preflight reports `STORAGE_NOT_PRIVATE_CANONICAL_DIRECTORY` for unsafe ownership, permissions or aliases; it does not repair them.
- The first configured session root receives new sessions.
- Project cwd comes from the native session header and is validated independently of the storage path. Configure roots and project grants together; neither implies the other.
- Saved history can remain readable when its cwd is unavailable, provided the remaining permission policy authorizes the read. Creating a session or cold-starting a writer requires a real, canonical project directory. Existing cooperating owners remain controllable if their original cwd disappears.

### Native environment

By default the child runs the user's installed `pi` from the service process's PATH, inherits that process's environment and uses normal Pi discovery for tools, packages, extensions, skills and project context. Pi resolves authentication through its native configuration and inherited environment. A service may have a different PATH from your interactive shell; configure its environment or set `piExecutable` explicitly. Missing Pi returns `PI_EXECUTABLE_NOT_FOUND`; an explicitly selected non-executable path returns `PI_EXECUTABLE_NOT_EXECUTABLE`. Neither error falls back to the Bridge's development dependency. Existing cooperating writers are reused without resolving or starting another executable.

Explicit `piRuntime` keys:

- `agentDir`: absolute alternative native agent directory.
- `inheritEnv`: environment-variable allowlist. Omitting it inherits the normal environment; an empty list isolates it.
- `tools`: subset of native read/write/edit/bash/grep/find/ls. Omitting it leaves native defaults; an empty array disables built-in tools.

A `piRuntime` override changes the runtime environment; it is not a permission grant. Model tools and installed extensions can run shell commands, access files or make network calls, so denying the Bridge's direct `command` tool does not sandbox a prompt authorized by `send`.

### Native control permissions

- `send`: model discovery, model/thinking settings, manual `compact` and idle RPC `reload`.
- `create`: a `create` call's initial model selection.
- `stop`: required in addition to `send` only for explicit `compact(interrupt:true)`. Default idle compaction and idle reopen do not need it.
- `read`: protects compaction summaries.

See [model control](model-control.md) for details.

## Seven independent rights

`list`, `read`, `send`, `command`, `stop`, `create` and `delete` are independent. All seven can be set at the default and project tiers. A session can override all except `create`, because creation targets a project, not an existing session.

Example project override (set only the rights you intend):

```json
{
  "folder": "/home/example/project",
  "list": true,
  "read": true,
  "send": true,
  "stop": true,
  "create": true,
  "command": false,
  "delete": false
}
```

A session-specific override is `{"session_id":"ps_…","send":false}`.

Each right resolves separately, in this order:

1. The latest explicit boolean for the exact session.
2. The latest explicit boolean at the most specific containing project path, then its less-specific ancestors.
3. The `defaults` value for that right; `null` denies.

Within a project or session scope, a missing field leaves earlier entries unchanged. An explicit `null` removes that scope's override and restores inheritance. In project and session grants, unknown fields and values that are neither boolean nor `null` fail validation, including misspelled permission names.

Consequences:

- `list:false, read:true`: a known ID can be read but not discovered.
- `list:true, read:false`: listing metadata is visible, conversation content is not.
- `stop:true, read:false`: permits stop and its own withdrawn-input result.
- `command:true, read:false`: permits command output and receipt recovery.
- `create:true, send:false`: permits the initial prompt; later prompts need `send`. A fork also needs the parent's `read`.
- `delete:true` needs no `list`, `read`, `send` or `stop`, and grants no access to project files.

Backend checks apply to batch items, receipt recovery and read continuations. Permission edits are reloaded before each request and after significant owner or snapshot waits. Revocation does not roll back work already admitted to Pi. Configuration changes outside `defaults` and `grants` need a service restart.

### Diagnose combinations

`health({})` returns default/project effective rights, their sources, advisory warnings and the number of session overrides. Add a known `session_id` to get that session's effective rights; its project and name are not disclosed, and source labels give only the default/project/session tier. `health` never lists hidden session IDs and never changes permissions.

Warnings cover known-ID-only access, work without progress reading, work without stop, restricted access to newly created sessions, and the difference between direct shell permission and model tools. These are valid configurations, not validation errors or implicit permission dependencies.

### Native human menu

Load `src/owner-permissions-extension.mjs` into Pi with `PI_MCP_OWNER_CONFIG=/absolute/path/owner.json`, then press **Ctrl+Alt+P** in a native TUI. Choose this session, this project, another configured project or the defaults. Each field offers Allow, Block or Inherit and shows its effective source. Session menus omit `create`.

The menu is a human shortcut, not a model tool or slash command. It writes only the chosen field, preserves other settings, rejects concurrent edits and closes on native session lifecycle changes. A saved session outside the configured roots cannot be edited through this session's menu.

## Local preflight and deployment

`node deploy/check-owner.mjs /absolute/path/owner.json` validates the configuration and its filesystem/privacy constraints. For HTTP, create a private random token file and add the `http` block described in [transports](transports.md).

`deploy/pi-mcp-bridge.service` is an optional user-systemd template. Review its installation paths, environment and stop budget before use. Autostart/linger, tunnel organization login and external authentication are owner deployment decisions.

After a Bridge process crash, its state lock is retained. Confirm that the exact former Bridge and all owned native writers have exited before removing `stateDir/bridge.lock`. Never delete the registry's writer claims to make an unreachable live owner look dead. Local handoff fences have a separate reset procedure in [runtime](runtime.md).
