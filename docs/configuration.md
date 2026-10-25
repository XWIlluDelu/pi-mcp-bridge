# Owner configuration and permissions

Use a canonical JSON file owned by the service user with no group/other
permissions. [The example](../deploy/owner.example.json) denies every operation;
replace its paths with the projects and native session roots intended for access.
The Bridge rejects unsafe configuration files without changing their permissions.

## Settings

Unknown fields and incomplete baseline permissions are rejected. Project and
session grants may override subsets of their applicable rights. Projects use
canonical paths; there is no caller `principal` field.

| Key                       | Meaning                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stateDir`                | Private Bridge state, recoverable trash and service-exclusivity namespace.                                               |
| `sessionRoots`            | Nonempty array of absolute native session-storage directories.                                                           |
| `folders`                 | Configured creation targets, each `{path}` with an absolute project cwd. Inclusion grants no rights.                     |
| `defaults`                | All seven permission keys, each boolean or `null`; `null` denies.                                                        |
| `grants`                  | Project/session permission overrides.                                                                                    |
| `attachmentDir`           | Shared private registry directory; defaults to `stateDir/ipc`. Cooperating owners must use the same canonical directory. |
| `attachmentExitTimeoutMs` | Owner-exit budget, 50–30000 ms, default 5000. Delete uses it as the SIGTERM grace period before SIGKILL.                 |
| `piExecutable`            | Absolute installed Pi CLI path, including symlinks. Omission selects Pi from the launch environment's PATH.              |
| `piArgs`                  | Additional native CLI arguments; incompatible ownership/selection flags reject.                                          |
| `compatibilityModules`    | Optional trusted plugin integrations; see [module configuration and API](compatibility.md#owner-configuration).          |
| `herdr`                   | Boolean, default `false`; hot-read when launching a new RPC writer.                                                      |
| `piRuntime`               | Explicit native environment overrides below.                                                                             |
| `http`                    | `{port,tokenFile}` for HTTP/proxy entry points; see [transports](transports.md).                                         |

### Storage and project paths

- Storage roots and state must not overlap or resolve through directory aliases.
  Session-file symlinks and hardlink aliases reject.
- `stateDir` and `attachmentDir` must be user-owned and private. Native Pi storage
  may use ordinary 0755 directories and 0644 files: an owned private ancestor
  protects descendants; otherwise the canonical directory chain and file must
  not be writable by other users. Sticky temporary-directory ancestors are
  allowed. Unsafe storage rejects without chmod.
- `sessionRoots` bounds discovery and access. Creation follows native destination
  precedence: `piArgs --session-dir`, inherited `PI_CODING_AGENT_SESSION_DIR`,
  merged project/global `sessionDir`, then Pi's per-project default under the
  effective agent directory. The destination must lie inside an existing
  configured root; otherwise creation rejects with `NATIVE_SESSION_OUTSIDE_ROOTS`
  before publication or prompting. Unsafe destination paths return
  `UNSAFE_NATIVE_SESSION_STORAGE`.
  Root order does not choose the destination, and existing sessions are not moved.
- Project grants follow the normalized absolute cwd recorded in the native
  header, independently of the storage location or current workspace existence.
  Missing/empty cwd grants no project scope and cannot cold-start a writer;
  session/default permissions may still authorize history access.
- Workspace removal does not revoke history, control or notification rights.
  Create and cold startup require the project directory at its canonical path;
  file or symlink replacements cannot redirect execution. Existing cooperating
  owners remain controllable under their grants if their original cwd disappears.

### Native environment

The child inherits the service process's environment and uses normal Pi discovery
for authentication, tools, packages, extensions, skills and project context.
A service's PATH may differ from an interactive shell; configure it or set
`piExecutable` explicitly. Relative PATH entries resolve from the Bridge/launcher
cwd, not the target project.

The CLI's real path identifies the external Pi package whose declared SDK and
dependencies supply all native APIs. Bridge has no bundled Pi dependency.
Missing/non-executable selections report `PI_EXECUTABLE_NOT_FOUND` or
`PI_EXECUTABLE_NOT_EXECUTABLE`; wrappers without an identifiable matching SDK
report `PI_INSTALLATION_UNAVAILABLE`. An explicit selection does not fall back
to PATH. Existing cooperating writers are reused without resolving another
executable. After replacing Pi, restart Bridge and reopen affected owners at a
safe boundary so their loaded native modules agree.

`piRuntime` accepts:

- `agentDir`: absolute alternative native agent directory, supplied as
  `PI_CODING_AGENT_DIR`.
- `inheritEnv`: environment-variable allowlist. Omission inherits normally; an
  empty list removes inherited variables except PATH, which is preserved or
  defaults to `/usr/bin:/bin`.
- `tools`: subset of native read/write/edit/bash/grep/find/ls. Omission uses
  native defaults; an empty array disables built-in tools.

These settings change the runtime, not its permission grants. Model tools and
extensions can access files, shell and network: denying the direct Bridge
`command` tool does not sandbox an authorized prompt.

### Herdr process placement

With `"herdr":true`, Bridge checks PATH then `~/.local/bin/herdr` for new RPC
writers. Missing Herdr selects direct startup; installed but unavailable or
incompatible Herdr fails without relaunching a possibly started writer elsewhere.
Herdr requires Linux and a working user-systemd bus. Bridge may start its local
daemon but does not restart an existing daemon or change service enablement/linger.

Existing owners take priority. Edits affect subsequent new-session and cold-start
launches without moving or stopping current writers; there is no per-call or
saved-session backend choice. Each launch gets an unfocused RPC pane with the
same Pi executable, resources and environment as direct startup. Private sockets
carry the native RPC stream. [Runtime lifecycle](runtime.md) governs EOF, release
and deletion of the allocated worker/tool scope.

### Native control permissions

`set_model`, prompt settings, `compact` and `reload` use session `send`; a create call's
initial settings use `create`. Explicit `compact(interrupt:true)` additionally
requires `stop`, while summary content requires `read`.

`models` requires effective `send`, `command` or `create` on a configured project,
or effective `send`/`command` on an existing in-scope session. Normal overrides
apply; superseded grants and nonexistent IDs do not authorize it. Catalog
admission may read identity metadata, but no history or owner state. See
[model control](model-control.md) for operation behavior.

## Seven independent rights

`list`, `read`, `send`, `command`, `stop`, `create` and `delete` resolve independently.
All apply at default/project tiers; sessions may override all except `create`,
which targets a project.

Example project override:

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

A session override is `{"session_id":"ps_…","send":false}`. Each right resolves
in this order:

1. Latest explicit boolean for the exact session.
2. Latest explicit boolean at the most specific containing project path, then
   less-specific ancestors.
3. The default value; `null` denies.

A missing grant field leaves earlier entries unchanged. Explicit `null` removes
that scope's override and restores inheritance. Unknown keys and values other
than booleans or `null` reject.

- `list:false, read:true` allows reading a known ID without discovery.
- `list:true, read:false` exposes metadata without conversation content.
- `stop` includes its own withdrawn-input result; `command` includes its output.
  Neither needs history `read`.
- `create:true, send:false` allows the initial prompt; later prompts need `send`.
  Fork additionally needs the parent's `read`.
- `delete` needs none of the other rights and grants no project-file access.

### Request permission snapshots

The authoritative Bridge starts one policy read on receipt of a complete,
schema-valid business request, before executor/session queues. Its immutable
`defaults`, `grants`, `folders` and `sessionRoots` snapshot governs admission,
execution and returned data through waits, cold startup and ACK handling.
Later edits affect new requests only. Proxy/client timestamps and native
execution time do not select the policy.

Batch items share the outer snapshot; fork source and destination checks share
it too. Every new call, including a read cursor page, captures a new policy.
Invalid or unreadable policy rejects without reusing an older snapshot.
Identity, cwd, generation, owner state, Stop and handoff checks remain live.
Input requests register their Stop fence before policy I/O. Late ACKs finish
identity checks using the admitted request's rights without replaying work.

`defaults`, `grants`, `folders` and `sessionRoots` hot-update together. Startup
provisions its roots; later policy reads create no directories. Discovery skips
missing roots and validates existing ones on access; native creation provisions
its selected destination. Removed roots exclude new requests, including known-ID
and cursor reads, without terminating writers or withdrawing admitted work.
Removing a folder removes a creation target, not grants for existing sessions.
Hot scope must remain non-overlapping with both proposed and active storage.

`herdr` is read separately at each writer launch. Other settings remain fixed
until service restart; pending changes appear by name in unscoped
`health.restart_required`, while active values continue serving requests.
An IPC namespace change additionally rejects new writer acquisition with
`CONFIG_RESTART_REQUIRED`, because the old registry cannot establish ownership
in the new namespace. Existing owner reuse and reads remain available.

Companions reread scope before native registration and resume admission.
Registered writers retain claims after scope removal. A previously unregistered
Pi newly brought into scope needs one safe native reload to register; there is
no background registration watcher.

### Diagnose combinations

`health({})` reports permission issues and pending restart settings. Healthy
policy with no restart pending returns `{"domain":"permissions","status":"ok"}`.
Issues identify allowed/blocked conditions and source rules, deduplicating
inherited issues. A known `session_id` limits diagnosis to that session without
exposing its project or name. Health never changes permissions.

Warnings cover known-ID-only access, work without progress reading or stop,
restricted access to new sessions, and direct shell versus model-tool access.
These combinations remain valid policies. Unscoped health also reports
unavailable [event storage](events.md#authorization-storage-and-delivery)
independently of core operation availability.

### Native human menu

Load `src/owner-permissions-extension.mjs` with
`PI_MCP_OWNER_CONFIG=/absolute/path/owner.json` and press **Ctrl+Alt+P** in a TUI.
Choose this session, the current native working-directory project, another
configured/granted project, or defaults. The session menu shows inheritance from
its recorded project. Fields offer Allow, Block or Inherit with their effective
source; session menus omit `create`. Editing grants does not add creation targets.

Edits use recorded normalized paths without requiring a workspace or following
replacement symlinks. A persistent session can receive a grant before its first
message, using its reserved canonical file and native ID; in-memory sessions,
out-of-root paths and aliases are ineligible. The owner-local menu changes only
the chosen field, rejects concurrent edits and closes on session lifecycle
changes. It neither starts Pi nor writes history.

## Startup and deployment

Startup validates configuration and filesystem boundaries. For HTTP, create a
private random token file as described in [transports](transports.md).
`deploy/pi-mcp-bridge.service` is an optional user-systemd template; review its
paths, environment and stop budget. Autostart/linger and tunnel authentication
remain owner deployment choices.

Service exclusivity and permission edits use separate kernel-owned mutexes;
crashes release them. Edits compare the captured revision before atomic
replacement. Startup removes only its own stale owner-control socket after
obtaining service exclusivity. Session writer claims and explicit pauses follow
the [runtime ownership rules](runtime.md).
