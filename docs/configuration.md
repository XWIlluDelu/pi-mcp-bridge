# Owner configuration and permissions

Use a canonical JSON file owned by the service user with no group/other permissions. Both direct transports and request policy reads enforce this; permissions are never repaired automatically. [The example](../deploy/owner.example.json) denies every operation. Replace its paths with directories you explicitly intend the Bridge to access. When only some projects are authorized, configure those projects' session roots rather than a broad parent.

## Settings

Only the fields below are accepted. Unknown fields and incomplete baseline permissions are rejected. Project and session grants can override subsets of their applicable rights. Projects use canonical paths, not folder IDs; there is no caller `principal` field. Use the current example when updating a configuration, and update Bridge, companion and host bindings together.

| Key                       | Meaning                                                                                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stateDir`                | Private Bridge state and recoverable session trash; also the namespace for service exclusivity.                                                                                                                                                |
| `sessionRoots`            | Nonempty array of absolute native session storage directories.                                                                                                                                                                                 |
| `folders`                 | Configured creation targets, each `{path}`; `path` is the absolute project cwd. Inclusion alone grants nothing.                                                                                                                                |
| `defaults`                | Required baseline with all seven permission keys. Each value is boolean or `null`; `null` denies at this scope.                                                                                                                                |
| `grants`                  | Project/session permission overrides.                                                                                                                                                                                                          |
| `attachmentDir`           | Optional shared private registry directory; every cooperating owner must use the same canonical directory.                                                                                                                                     |
| `attachmentExitTimeoutMs` | Optional 50–30000 ms owner-exit verification budget.                                                                                                                                                                                           |
| `piExecutable`            | Optional absolute path to your installed Pi CLI (symlinks allowed); otherwise the launch environment's PATH selects Pi. The same installation supplies its SDK and dependencies. Missing/unidentifiable installations fail without a fallback. |
| `piArgs`                  | Optional additional native CLI arguments; the launcher and runtime reject incompatible ownership/selection flags.                                                                                                                              |
| `herdr`                   | Optional global boolean, default `false`. Use local Herdr for subsequent new RPC writers when installed; otherwise start directly. Hot-read at the launch boundary.                                                                            |
| `piRuntime`               | Explicit launch overrides, described below.                                                                                                                                                                                                    |
| `http`                    | Optional `{port,tokenFile}`; required for HTTP/proxy entry points.                                                                                                                                                                             |

### Storage and project paths

- Storage roots and state must not overlap or resolve through directory aliases. Session-file symlinks and hardlink aliases are rejected.
- Existing `stateDir` and `attachmentDir` must belong to the service user and have no group/other permissions. Native session storage has a separate integrity rule, not a 0700 rule: Pi's ordinary 0755 directories and 0644 files are supported. An owned private ancestor protects descendants; otherwise the entire canonical directory chain and the actual file must not be writable by other users. Sticky temporary-directory ancestors are allowed. Unsafe storage is rejected without chmod.
- `sessionRoots` bounds discovery and access; its order does not select the destination for `create`. New sessions use the target project's native Pi location: `piArgs --session-dir`, then inherited `PI_CODING_AGENT_SESSION_DIR`, then merged project/global `sessionDir`, otherwise Pi's per-project default under the effective agent directory. `piRuntime.agentDir` and `inheritEnv` apply to this selection just as they do to runtime launch.
- The native destination must be inside an existing configured session root. Otherwise `create` rejects with `NATIVE_SESSION_OUTSIDE_ROOTS`, without publishing a session or sending a prompt; it never falls back to the first root or expands the roots. Destination directories must satisfy the native canonical-path integrity checks; unsafe existing directories are rejected, not chmodded. Existing sessions are not moved.
- Project cwd comes from the native session header and is validated independently of the storage path. Configure roots and project grants together; neither implies the other.
- Saved history can remain readable when its cwd is unavailable, provided the remaining permission policy authorizes the read. Creating a session or cold-starting a writer requires a real, canonical project directory. Existing cooperating owners remain controllable if their original cwd disappears.

### Native environment

By default the child runs the user's installed `pi` from the service process's PATH, inherits that process's environment and uses normal Pi discovery for tools, packages, extensions, skills and project context. Pi resolves authentication through its native configuration and inherited environment. A service may have a different PATH from your interactive shell; configure its environment or set `piExecutable` explicitly. Missing Pi returns `PI_EXECUTABLE_NOT_FOUND`; an explicitly selected non-executable path returns `PI_EXECUTABLE_NOT_EXECUTABLE`. Bridge has no bundled or development Pi dependency. Existing cooperating writers are reused without resolving or starting another executable.

Explicit `piRuntime` keys:

- `agentDir`: absolute alternative native agent directory.
- `inheritEnv`: environment-variable allowlist. Omitting it inherits the normal environment. An empty list removes inherited variables except `PATH`, which is always preserved for executable discovery (or defaults to `/usr/bin:/bin` if absent).
- `tools`: subset of native read/write/edit/bash/grep/find/ls. Omitting it leaves native defaults; an empty array disables built-in tools.

A `piRuntime` override changes the runtime environment; it is not a permission grant. Model tools and installed extensions can run shell commands, access files or make network calls, so denying the Bridge's direct `command` tool does not sandbox a prompt authorized by `send`.

### Herdr process placement

Set `"herdr": true` in the owner file to run new Pi RPC writers in Herdr. Bridge checks its own PATH, then `~/.local/bin/herdr`. A missing executable selects direct startup; an installed but unavailable or incompatible Herdr reports a startup error rather than retrying a possibly launched writer elsewhere. The Herdr path requires Linux and a working user-systemd bus for worker scopes. It can start a local daemon if none is running; it does not restart an existing daemon or change service enablement/linger.

Existing connected Pi owners always take priority. The switch applies to both new sessions and cold starts of saved sessions; edits affect only later process launches. Turning it off neither moves nor stops current writers. There is no per-call override or saved session backend preference.

Herdr receives a dedicated, unfocused RPC pane, not an interactive Pi TUI. Pi uses the same executable, arguments, native resources, authentication and Bridge observer as direct startup; private sockets carry its unchanged RPC stream. Herdr pane context identifies the new pane. Native EOF, task auto-release, Stop and owner identity checks retain their existing meanings. Worker cleanup waits for actual process-scope exit, never force-kills on a timeout, and removes only the allocated pane and private IPC files. Bridge and Inspire do not import or share transport implementations.

### Native control permissions

- `models`: requires effective `send`, `command` or `create` on a configured project, or effective `send`/`command` on an existing in-scope native session. Normal per-right override priority applies; a superseded grant or nonexistent ID is insufficient. Authorization may read identity metadata, never history or owner state. Catalog access neither starts nor binds a session and grants no session operation.
- Session `send`: model/thinking prompt settings and manual `compact`.
- `create`: a `create` call's initial model selection.
- `stop`: required in addition to `send` only for explicit `compact(interrupt:true)`. Default idle compaction does not need it.
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
- `command:true, read:false`: permits command output without granting history read.
- `create:true, send:false`: permits the initial prompt; later prompts need `send`. A fork also needs the parent's `read`.
- `delete:true` needs no `list`, `read`, `send` or `stop`, and grants no access to project files.

### Request permission snapshots

The authoritative Bridge starts one policy read when it receives a complete, schema-valid business request, before executor or session queues. The resulting independent, immutable snapshot includes `defaults`, `grants`, `folders` and `sessionRoots`. It governs that request's directory scope, permission checks, execution and returned data, including waits, cold startup, native ACKs and inline output delivery. Later permission and scope edits affect new requests only; they neither revoke nor add access to an in-flight request. The stdio proxy only forwards requests; client/proxy timestamps and the later native execution time do not select the policy.

All items of one batch share its outer request's snapshot. Fork source `read` and destination `create` checks use that same snapshot. Listing, parent references, page-local `creatable_projects`, authorized model catalogs and health diagnostics also use the request snapshot.

Every new call captures a new policy, including every new mutation and each read cursor page. A read cursor is not an authorization token. Late ACKs finish native identity checks without replaying work or acquiring rights from another request; permission snapshots are process-local, not persisted credentials.

Snapshot authorization does not freeze session/file/native IDs, cwd, generation, owner or execution state. Identity checks, single-writer protection, Stop/handoff fences, cancellation and lifecycle checks still apply throughout execution. Input requests register their Stop fence before waiting for policy I/O. Invalid/unreadable policy rejects a new request without falling back to an older policy. `folders` and `sessionRoots` hot-update together with `defaults` and `grants`; they do not require a Bridge restart. Request snapshots never create storage directories. Startup provisions its configured roots; after a scope edit, discovery skips missing roots and validates existing roots when accessing them. Native creation provisions its selected destination on demand. Non-overlap validation still applies to the configuration, and actual session accesses retain their native storage integrity checks. Removed roots exclude new requests, including known session IDs and cursor continuations; they do not terminate writers, withdraw already-admitted work or remove ownership claims. Removing a folder removes that creation target, not access to existing sessions whose native cwd is there.

`herdr` is read separately at each new writer launch, rather than frozen into the permission snapshot. Other settings remain fixed for the service lifetime. `stateDir` and `attachmentDir` identify held locks, trash and IPC ownership; HTTP settings identify the bound listener and token; Pi executable, arguments and environment select the running native runtime. Changes apply only after restarting the relevant service. Until then, the active values remain in use: pending changes do not impose a global business-request gate. A proposed IPC namespace change still refuses new writer acquisition with `CONFIG_RESTART_REQUIRED`: the old registry cannot establish that the new namespace has no writer. Existing owner reuse and reads remain available. Unscoped `health({})` reports their names in `restart_required`, never their values. Hot scope is also validated against active storage so a proposed `stateDir` cannot hide an overlap with the currently held state directory.

An installed companion rereads directory scope before native session registration and resume admission. Existing registered writers retain their claims through a scope removal; admitted Bridge requests still use their captured scope. A Pi already open outside the former scope and never registered is not discovered merely by editing the file: use one native safe reload to register it before remote use. No Bridge restart or background directory watcher is required.

### Diagnose combinations

`health({})` reports noteworthy permission combinations and, when present, the fixed settings awaiting restart. A healthy configuration with no pending restart returns `{"domain":"permissions","status":"ok"}`. Issues include their relevant allowed/blocked conditions and source rules; the same inherited issue is reported once, without normal permission tables or repeated project configuration. Add a known `session_id` to diagnose only that session; source labels show the tier without disclosing its project or name. `health` never changes permissions.

Warnings cover known-ID-only access, work without progress reading, work without stop, restricted access to newly created sessions, and the difference between direct shell permission and model tools. These are valid configurations, not validation errors or implicit permission dependencies.

### Native human menu

Load `src/owner-permissions-extension.mjs` into Pi with `PI_MCP_OWNER_CONFIG=/absolute/path/owner.json`, then press **Ctrl+Alt+P** in a native TUI. Choose this session, this project, another configured project or the defaults. Each field offers Allow, Block or Inherit and shows its effective source. Session menus omit `create`.

The menu is a human shortcut, not a model tool or slash command. It writes only the chosen field, preserves other settings, rejects concurrent edits and closes on native session lifecycle changes. A saved session outside the configured roots cannot be edited through this session's menu.

## Startup and deployment

Startup validates configuration and filesystem boundaries directly. For HTTP, create a private random token file and add the `http` block described in [transports](transports.md).

`deploy/pi-mcp-bridge.service` is an optional user-systemd template. Review its installation paths, environment and stop budget before use. Autostart/linger, tunnel organization login and external authentication are owner deployment decisions.

Service exclusivity and permission edits use independent Linux kernel-owned mutexes. A crash releases each mutex; permission edits still compare the captured revision before atomic replacement. After obtaining service exclusivity, startup removes only its own namespace's stale owner-control socket. It does not remove session writer claims: surviving native writers still block takeover through exact PID/start/boot and generation checks. An explicit local pause has a separate reset procedure in [runtime](runtime.md).
