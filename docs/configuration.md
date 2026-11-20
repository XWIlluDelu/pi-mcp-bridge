# Owner configuration and permissions

Use a JSON file owned by the service user that is not writable by group or other
users (symlinks such as dotfiles and read-only modes like `0644` are allowed; secret
files like `http.tokenFile` still require `0600` without symlinks).
[The example](../deploy/owner.example.json) denies every operation;
replace its paths with the projects and native session roots intended for access.
The Bridge rejects unsafe configuration files without changing their permissions.

## Configure one project

Start from the example copied in the [local setup](../README.md#start-locally).
For a project such as `/home/example/project`, edit these fields together:

1. Choose `stateDir` for Bridge's private state, separate from native session
   storage. Leave `attachmentDir` unset to use `stateDir/ipc`, or choose a shared
   private directory for all cooperating owners.
2. Set `sessionRoots` to the directories containing the native sessions you want
   to expose. Pi's `/session` command shows the current session file; use its
   containing directory, not the file itself or the project directory. If Bridge
   will create sessions, include the destination chosen by Pi's
   [storage settings](#storage-and-project-paths).
3. Add the canonical project path to `folders` if it should be a creation target.
   This does not grant access. Existing sessions are authorized by their recorded
   project cwd, independently of where their files are stored.
4. Keep the example's complete deny-by-default baseline and replace `grants:[]`
   with the project overrides you need. For example, the following permits
   session collaboration and creation while leaving direct commands and deletion
   disabled:

```json
[
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
]
```

`send` allows Pi to use its native tools and extensions; `command:false` disables
only Bridge's direct shell operation. See [native environment](#native-environment)
for explicit runtime overrides and [permission resolution](#seven-independent-rights)
for inheritance. All clients of this owner configuration share its policy; the
configuration does not define separate caller identities.

Connect through [stdio or HTTP](transports.md#choose-a-process-topology), then
follow the [first-connection checks](../README.md#verify-the-first-connection).
The settings reference below covers additional controls and later policy edits.

## Settings

Unknown keys reject.

| Key                       | Meaning                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `stateDir`                | Private Bridge state, [trash recovery index](api.md#delete) and service-exclusivity namespace.                           |
| `sessionRoots`            | Nonempty array of absolute native session-storage directories.                                                           |
| `folders`                 | Configured creation targets, each `{path}` with an absolute project cwd. Inclusion grants no rights.                     |
| `defaults`                | Default rights as booleans or `null`. Omitted and null rights deny.                                                      |
| `grants`                  | Project/session permission overrides.                                                                                    |
| `attachmentDir`           | Shared private registry directory; defaults to `stateDir/ipc`. Cooperating owners must use the same canonical directory. |
| `attachmentExitTimeoutMs` | Owner-exit budget, 50–30000 ms, default 5000. Delete uses it as the SIGTERM grace period before SIGKILL.                 |
| `piExecutable`            | Absolute Pi CLI or official managed-launcher path; symlinks accepted. Omission uses the launch PATH.                     |
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
  Create and cold startup require the project path to resolve to an existing
  directory (symlinks to directories are resolved; missing or non-directory paths
  reject). Existing cooperating owners remain controllable under their grants if
  their original cwd disappears.

### Native environment

The child inherits the service process's environment and uses normal Pi discovery
for authentication, tools, packages, extensions, skills and project context.
A service's PATH may differ from an interactive shell; configure it or set
`piExecutable` explicitly. Relative PATH entries resolve from the Bridge/launcher
cwd, not the target project.

The selected npm CLI identifies the external Pi package whose declared SDK and
dependencies supply all native APIs. The official managed installer is also
supported: Bridge reads its current `releases-v1` installation marker and release
selection, then binds that release's CLI and SDK together. It launches the selected
CLI directly, preserving the installer's managed Node PATH and
`PI_MANAGED_INSTALL_ROOT`; a concurrent update cannot switch that launch to another
release after SDK resolution. Bridge has no bundled Pi dependency.
Missing/non-executable selections report `PI_EXECUTABLE_NOT_FOUND` or
`PI_EXECUTABLE_NOT_EXECUTABLE`; invalid managed metadata, mismatched releases and
other wrappers without an identifiable matching SDK report
`PI_INSTALLATION_UNAVAILABLE`. An explicit selection does not fall back
to PATH. Existing cooperating writers are reused without resolving another
executable.

Managed updates select a new release for subsequent resolutions; existing owners
continue using their loaded release. After an in-place npm update, restart Bridge
and reopen affected owners at a safe boundary to replace Node's cached native
modules.

`piRuntime` accepts:

- `agentDir`: absolute alternative native agent directory, supplied as
  `PI_CODING_AGENT_DIR`.
- `inheritEnv`: environment-variable allowlist. Omission inherits normally; an
  empty list removes inherited variables except PATH, which is preserved or
  defaults to `/usr/bin:/bin`.
- `tools`: selectors passed to Pi's native `--tools`, including extension
  tools. Omission uses native defaults. An empty array passes `--no-tools`.

These settings change the runtime, not its permission grants. Model tools and
extensions can access files, shell and network: denying the direct Bridge
`command` tool does not sandbox an authorized prompt.

### Herdr process placement

With `"herdr":true`, Bridge checks PATH then `~/.local/bin/herdr` for new RPC
writers so remote agents drive Pi inside Herdr just like local Herdr usage.
Bridge starts the local Herdr daemon on demand without restarting an existing
daemon or changing service enablement/linger. If Herdr is missing, unavailable,
incompatible, or user-systemd is unavailable before a pane is launched, Bridge
silently falls back to direct Pi startup so core sessions continue working. If
failure occurs after a Herdr worker launch has already started, Bridge aborts
without launching a duplicate writer elsewhere.

Existing owners take priority. Edits affect subsequent new-session and cold-start
launches without moving or stopping current writers; there is no per-call or
saved-session backend choice. Each launch gets an unfocused RPC pane with the
same Pi executable, resources and environment as direct startup. Private sockets
carry the native RPC stream. [Runtime lifecycle](runtime.md) governs EOF, release
and deletion of the allocated worker/tool scope.

### Native control permissions

[Model controls](model-control.md) lists rights for model selection, prompt
settings, compaction and catalog access. Reload uses `send`.

## Seven independent rights

`list`, `read`, `send`, `command`, `stop`, `create` and `delete` resolve independently.
All apply at default/project tiers; sessions may override all except `create`,
which targets a project.

The [first-project example](#configure-one-project) shows a project override.
A session override is `{"session_id":"ps_…","send":false}`. Put each override
inside the `grants` array. Each right resolves in this order:

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

Bridge reads policy once when a complete, valid request arrives, before it
enters any executor or session queue. Batch items and both sides of a fork
share that snapshot. Each continuation takes a new one. Invalid policy
rejects the request. Identity, owner state, Stop and handoff checks remain live.

`defaults`, `grants`, `folders` and `sessionRoots` hot-update together. Roots
must remain disjoint from active and proposed state storage. Removed roots
exclude new requests, including known IDs and cursors. Registered owners keep
their claims. Removing a folder only removes the creation target. Companions
read current scope when registering or resuming.

`herdr` is sampled for each new owned RPC. Other settings take effect after
restart and are listed in `health.restart_required`. Changing the registry
namespace blocks new writer acquisition with `CONFIG_RESTART_REQUIRED`.

### Diagnose combinations

[Health](api.md#health) explains limited permission combinations, pending
restart settings and unavailable event storage. Its warnings leave policy
decisions to the owner.

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

[The user-systemd template](../deploy/pi-mcp-bridge.service) is optional. Set
its paths, environment and stop budget for your installation. Set up the private
HTTP token and tunnel as described in [transports](transports.md).

## Diagnostics

Set `PI_MCP_LOG=1` in the launch environment to emit JSON diagnostics on stderr.
Group related stages by `trace_id` and identify the process with `run_id` and
`pid`. Hashed `session_ref` and `mcp_id_ref` correlate operations. Diagnostics
contain allowlisted metadata. Native and extension output is separate.

Use the operation code, [model catalog stages](model-control.md#session-independent-model-catalog)
or [webhook diagnostics](events.md#authorization-storage-and-delivery) to locate
failures. Delivery of log records is best effort. Use the
[submission receipt](api.md#submission-receipt) for uncertain input.
