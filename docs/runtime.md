# Native runtime, ownership and local entry

The Bridge reuses a cooperating live Pi instance. It starts an RPC child only
when no live registered writer owns the saved session. Ownership includes the
native session ID, canonical file, generation and exact Linux process identity
(PID, process start time and boot ID). A live but unreachable owner blocks
control and cold startup; it never authorizes a fallback writer.

Registry transactions use one Linux abstract Unix socket derived from the
canonical private IPC directory. The kernel releases this short mutex on process
death; contention has a bounded wait and no lockfile recovery/migration path.
All cooperating processes must share the registry and Linux PID/network
namespaces. Releasing this mutex does not release a session's writer claim:
those claims still require exact process identity and appropriate exit evidence.
Registry scans isolate protocol mismatches to the target path or exact process
identity after validating bounded private storage and unambiguous scope. Direct
access reports `ATTACHMENT_PROTOCOL_MISMATCH`; update the Bridge and companion
together. No mismatched record is translated or used to attach a runtime.

This is a cooperative registry, not a global lock imposed on every Pi process.
An unregistered RPC process has no generic attach-by-PID API. Its original host
must load the companion/controller, or close it before a cooperative reopen.
Multiple MCP clients should share one Bridge service; independent Bridge
processes do not proxy each other's private RPC pipes.

An owned RPC is bound to its reserved session file. Its observer cancels native
new-session, fork and cross-file resume before Pi opens a target. Use Bridge
create/fork for new sessions; cross-session extension workflows need a TUI or
host that manages their ownership. Identity observation rejects mismatches and
invalidates scoped events without stopping the process.

For an ordinary companion, scoped native resume checks existing target-path
claims before Pi opens the target and cancels another process's live ownership.
The current session remains usable; use `/bridge-join` or host coordination for
a managed handoff. This read-only check creates no reservation. It does not make
simultaneous opens atomic or protect initial startup before extension loading;
`session_start` retains its post-open check, and unregistered writers remain
outside the cooperative registry.

## Runtime capabilities

| Capability              | Bridge-owned RPC                              | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings            |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Read context            | Yes                                           | Yes                                                   | Native snapshot                           |
| Live text/thinking      | Native delta events                           | Public extension events                               | When the host supplies live observation   |
| Send text/images        | Native ACK                                    | Submission observable; acceptance unknown             | Native RPC ACK or SDK submission evidence |
| Prompt + model/thinking | Proven-idle only                              | Unsupported                                           | Unsupported                               |
| Native command / stop   | Yes, including queued-input withdrawal        | Unsupported                                           | Yes                                       |
| Manual compact          | Idle by default; explicit interrupt supported | Explicit interrupt; native callbacks                  | Explicit interrupt via native methods     |
| TUI handoff             | Drain and normal EOF, then reserved TUI join  | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                   |

Saved sessions can be read without a runtime. Pi-readable v1/v2 histories are
normalized only in memory through native pure parsing/migration. Malformed
records are skipped as in Pi; `read.history` reports skipped lines and an
unterminated tail. Read never repairs or migrates the file on disk.
Authorized writer open remains responsible for native persistence. Missing or empty native cwd remains readable under session/default permissions; it grants no project scope and cannot cold-start execution.

Authorized send, command or compact can cold-start an RPC; stop never does. `list.status` observes a live owner's current model/thinking, or null when the native selection is unobserved. Current custom hosts declare boolean capabilities from the callbacks they implement.

Bridge-owned RPCs remain open between operations. Owner-local release and TUI
handoff close them through normal EOF. Native launch overrides apply on every cold start.
Read/list do not reopen a saved session.
Companion TUI/RPC instances and supplied hosts retain their own lifecycle.
On native shutdown/switch, the companion fences admissions and drains its
admitted manual compaction before allowing a fresh
session_start to retire the old claim. Socket loss does not settle those calls.

The ordinary companion returns `PI_ACCEPTANCE_UNOBSERVABLE` after
`sendUserMessage()`; a successful transport write is not an admission ACK.
It returns `BASH_UNSUPPORTED` / `STOP_UNSUPPORTED`, rather than presenting
agent-only abort as stop-all. A native command must use Pi's bash path, including
`user_bash`, native history and cancellation—not a second shell executor.

Idle-only admission also checks native pending queues: `isIdle` alone does not
include retained follow-ups after abort. SDK bindings also account for their
unfinished prompt promises, including asynchronous input preparation; idle_only
skips them until actual completion/rejection. Other send modes retain native
queue behavior. Remote companion/host inputs refuse
`/bridge-join` and its collision aliases before native command dispatch; that
control path remains owner-local.

Default sending follows ordinary TUI Enter: steer while busy. Explicit
follow-up maps to Pi's follow-up queue. Pi's configured queue consumption modes
remain in effect. Idle-only checks available admission/preparation state and
does not silently convert a busy input into a queued one.

## Model settings and compaction

Owners expose their current model/thinking through
`state`, observed by `list.status`. Prompt model/thinking selection requires an
owned RPC; attached compaction uses native callbacks with explicit interrupt
support. See [native controls](model-control.md) for queue/model timing, default
idle-only compaction and permissions.

## Image-capable owners

Image input passes through owned RPC prompt commands, Pi's
`RpcClient.prompt(text, images, streamingBehavior)` binding, SDK prompt options,
and companion `sendUserMessage()` content blocks. See [image input](api.md#image-input-send-and-create)
for accepted payloads and limits. It uses the existing send/create grants.

The registry advertises `imagesSupported: true` for an updated companion.
The supplied SDK/RPC bindings declare `supportsImages: true`; a custom host's
callbacks must explicitly declare the same flag and forward `submit().images`
to its native input API. Omitting the declaration keeps text working but
rejects image submissions. Existing running owners do not gain the capability
merely because their files were updated: the native owner must reload or reopen them.

## Daily TUI and ordinary RPC registration

To make ordinary `pi` launches participate, add the companion's absolute path
to the native agent settings (`~/.pi/agent/settings.json`, or the selected
`PI_CODING_AGENT_DIR`). Merge with the existing `extensions` array; keep all
other settings and packages:

```json
{
  "extensions": ["/absolute/pi-mcp-bridge/src/attach-extension.mjs"]
}
```

Use the same canonical file as the Bridge installation's `open.mjs`; do not
install a copied wrapper as a second extension. Pi deduplicates the normal
settings entry and an explicit `-e` for the same canonical file.

A Bridge-owned RPC supplies its current registry directory and already holds
the writer claim. An installed companion defers to that claim rather than
loading an unrelated default owner profile or publishing a second endpoint.

The daily companion reads the existing private owner configuration at
`$XDG_CONFIG_HOME/pi-mcp-bridge/owner.json`, or
`$HOME/.config/pi-mcp-bridge/owner.json`. `PI_MCP_OWNER_CONFIG` selects a
different file. No default configuration means the companion stays inactive;
an explicitly selected missing file or invalid/private-permission failure is
reported as an extension load error. The owner file must belong to the user
and have no group/other permissions.

This profile uses the configured `attachmentDir` (default `stateDir/ipc`) and
registers only sessions under the existing `sessionRoots`. It checks path
metadata before reading the session header or entries. No-session runs and
out-of-scope sessions get no endpoint. A fresh native session can reserve its
identity before first persistence; public discovery starts once Pi writes
the session file. Reload replaces the endpoint generation; switching away
retires that process's former companion claim without changing another owner.

A normal RPC host using that same native agent directory inherits the extension
through Pi settings, without a Bridge-specific host dependency. Its original
host retains stdin/stdout and process lifecycle control; Bridge uses the
private companion endpoint, not those pipes. Remote operations still require
the existing Bridge grants. Before enabling daily access, check that these
grants and roots cover exactly the sessions intended for remote use.

For an explicit one-off launch with the same scope:

```sh
PI_MCP_OWNER_CONFIG=/absolute/path/owner.json \
pi -e /absolute/pi-mcp-bridge/src/attach-extension.mjs
```

If `PI_MCP_ATTACH_DIR` is also set, it must agree with that owner file.
A directory-only `PI_MCP_ATTACH_DIR` remains the explicit low-level registration
path for hosts managing their own scope; it does not use the daily owner profile.
Use the owner profile, not directory-only configuration, for scoped daily access.

Existing processes do not load a newly configured extension automatically.
The native owner may use TUI `/reload` at a suitable time or launch its next
session normally; a plain RPC host must manage its own lifecycle. Registration
occurs too late to make blindly opening an already-owned target with
`--session` safe. A GUI started first can retain its Pi while Bridge joins via
the companion. A GUI opened after a Bridge-owned RPC needs an existing shared
control route or an explicit safe handoff; installing the companion alone does
not connect the GUI to that existing pipe.

## Open a Bridge session in a native terminal

With the owner Bridge running, in an interactive terminal:

```sh
node src/open.mjs /absolute/path/owner.json ps_SESSION_ID
```

The launcher finds the saved session's project directory, starts a **fresh**
native TUI and supplies `/bridge-join ps_SESSION_ID` as its initial command.
It loads the companion explicitly, inherits normal Pi configuration through the
owner's launch profile. It never starts with `--session TARGET`: Pi opens and may migrate that file
before loading extensions, which is too early to negotiate a live owner.
Owner `piArgs --session-dir DIR` is allowed: it only sets the fresh session's
storage directory. Existing-session selectors such as `--session`, `--session-id`,
`--continue`, `--resume` and `--fork` remain blocked until the negotiated join.

Cold RPC, create, reopen and the TUI launcher resolve the user's `pi` from the
child environment's PATH. The Bridge ignores its own SDK binaries even when npm
prepends them to PATH. It never silently substitutes that dependency for the
user's installation. `piExecutable` selects an explicit absolute executable;
missing or non-executable selections fail before spawning. Existing cooperating
owners are reused as-is, without replacing their process or version.

Pi 1.3.0 is the tested native/SDK baseline, not a production version override.
`piRuntime` environment, agent-directory and tool overrides remain explicit owner
choices. Otherwise native settings, packages, authentication, tools and extensions
are discovered normally from the process environment and project.

For example, an owner-config field `"piExecutable": "/usr/local/bin/pi"`
selects that executable. Without `piRuntime.inheritEnv`, the child inherits the
launching process's environment, including HOME, proxy/authentication variables
and any existing `PI_CODING_AGENT_DIR`. An explicit inherit list restricts
inheritance; `piRuntime.agentDir` explicitly sets `PI_CODING_AGENT_DIR`.
Neither path copies credentials or rewrites native settings. The open launcher
also supplies `PI_MCP_OWNER_CONFIG` and `PI_MCP_ATTACH_DIR` to its child.

Session-selection and noninteractive `piArgs` are rejected by the open launcher.
For an already-running ordinary TUI, load the companion with
`PI_MCP_OWNER_CONFIG` and `PI_MCP_ATTACH_DIR` set, then use `/bridge-join`
manually. Owner-local join is not a remotely callable prompt command.

### Handoff behavior

1. Fence new Bridge input and wait for previously admitted stop recovery.
2. Check RPC admission ACKs, native busy/queue/settlement state and observed
   input preflight. These observations do not cover arbitrary extension jobs.
3. Close the old owned RPC stdin and observe that exact child's normal exit.
   Lifecycle UI failures prevent destination reservation. Handoff does not
   escalate to process signals.
4. Reserve the target for the requesting TUI **before** `switchSession()`.
5. Recheck the reservation in Pi's cancellable pre-open hook and switch to the
   latest saved history.

Owner automation should call the handoff protocol directly. Idle-gated controls
and local release share its ACK, queue and settlement checks; completed queued RPC
input does not leave a lasting preflight barrier. New mutations are fenced during
handoff; reads remain available while it waits.

The owned RPC observer is loaded before explicit `piArgs` extensions so it sees
independent inputs before their asynchronous input handlers. This establishes
observation order, not completion correlation for those inputs.

Native Pi reports `before_agent_start` as busy. Earlier `input` hooks still precede
that busy state, and independent extension-origin input has no completion
correlation ID. An instance that has received such input can remain unconfirmed
even after a settlement event. Ordinary prompts remain available, but combined
prompt settings still require proven idle. If lossless release cannot be established, use the explicit interrupting
maintenance path below rather than inferring completion from a quiet stream.

Registered slash commands run before Pi's `input` event. An extension that
starts another command with `sendUserMessage(...,{expandPromptTemplates:true})`
and returns before that command finishes can leave work outside both input
observation and native run state. The Bridge has no native completion
notification for such detached commands. Ordinary handoff remains available, but does not promise to
preserve such unregistered background work. Finish that extension's work before
joining; repeated idle state reads cannot prove it completed.

While waiting, the fresh TUI does not mirror the old RPC's live output.
Notifications explain waiting/failure; Ctrl+Alt+J cancels. A startup extension
that begins unrelated local work can make the fresh TUI busy; join refuses
that state and can be retried explicitly once the local work finishes.
Cancellation before EOF restores admission; cancellation after EOF lets shutdown finish but does
not open the destination. A thrown, possibly partial native switch retains the
reservation until that process closes. A returned cancellation permits an
explicit retry, not an automatic retry loop.

Closing the native TUI ends its running work; it does not transfer that work to
a daemon. Ordinary join reserves the target only while its identified requester
is alive. A returned cancellation before native open deletes that reservation.
A possibly partial switch keeps the identified claim until exact process death.
A successful switch-away retires the previous session's claim; subsequent exit
of the destination cannot pause the previous session. Dead registered owners can
cold-resume from saved history. Live unreachable owners and unavailable process
identity still block startup.

### Recover an explicit local pause

An explicit owner-local release retains `noColdReacquire` for a possible
unregistered manual writer. This pause is separate from ordinary join:

1. Close the original writer and any unregistered Pi using that target.
2. Confirm local closure through the running Bridge's private control endpoint:

   ```sh
   node src/owner-runtime.mjs /absolute/path/owner.json reset ps_SESSION_ID --confirm-local-closed
   ```

3. Retry safe join or send a new authorized prompt to resume saved history.

Reset checks registered owner identity and refuses a live owner. It cannot
discover every unregistered Pi process; the caller confirms that local closure.
Do not delete claims to bypass a surviving writer.

For a deliberate idle owner-local release without opening a TUI, use:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json release ps_SESSION_ID
```

This fences new mutations, checks idle and waits for normal EOF exit without
signals. It retains the cold-resume fence until a cooperative join or explicit reset.

If the owner accepts interruption of running or unobservable preparation work:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json release ps_SESSION_ID --interrupt
```

This private local operation verifies the captured child, generation and exact
PID/start/boot identity, including a child already closing after EOF. It sends
SIGTERM and waits for its exit. It does not require idle, send SIGKILL on a timer,
or terminate a shared companion/host. Saved history remains intact; unfinished
in-memory work may be lost. After confirming all local writers have closed, use
the reset command above to permit cold resume of the same saved session.
A client timeout does not cancel an exit already requested or release ownership.
If signal delivery fails, the owner may retry explicitly after resolving the error;
there is no automatic retry.

Either release form can close a known Bridge-owned child after its history file
is removed, using its verified captured identity and claim. Replacement or unsafe
files still fail normal validation; release does not restore missing history.

## Shutdown and in-flight ACKs

Transports freeze admission, cancel local handoffs and interrupt owned writers
already exiting by EOF before draining requests. Already-dispatched inputs,
history reads and received ACK checks finish before the remaining owned runtimes
close. Queued operations may return `BRIDGE_CLOSING`; closing never starts a
replacement writer to run them.
Both per-request MCP and SDK tools participate in this drain. A normal EOF exit
checks synchronous activity after the last ACK/process-identity await. Newly
observed work prevents closing stdin; an owner-local release also withdraws its
reservation.

Bridge process shutdown also waits for SIGTERM termination without automatic
SIGKILL escalation. A process manager's independent stop timeout still applies;
configure it according to the owner's maintenance policy.

Running headless RPC sends `extension_ui_response {cancelled:true}` for extension
`confirm`, `select`, `input` and `editor` dialogs. It never approves or supplies
input. RPC internally records UI cancellation facts. Public send/create results report
`reason:"EXTENSION_UI_CANCEL_SENT"` after successful admission when cancellation was sent: Pi does not acknowledge UI response consumption.
The prompt's ACK is still admission, not proof that every UI promise finished.
Diagnostics emit `rpc.ui_request` / `EXTENSION_UI_CANCEL_SENT` without contents.
Notifications need no response and are exposed through
[`read.runtime_events`](reading.md#live-output-and-runtime-extension-events), along with native
`extension_error` events. Other display-only requests are ignored.

Before the first RPC readiness ACK, Bridge treats interactive UI as unavailable
and fails with `EXTENSION_UI_STARTUP_UNAVAILABLE`. In particular, an awaited
`session_start` dialog runs before Pi installs its stdin reader and cannot
consume a response; it no longer waits for the general ACK timeout. After EOF, shutdown UI cannot consume a
response. Its methods appear in `ui.unavailable`, and normal process exit still
returns `EXTENSION_UI_SHUTDOWN_UNAVAILABLE` to the handoff/reopen caller. A hook
may finish through its own timeout, or exit before its continuation runs; exit
code zero alone does not prove that every shutdown promise completed. These
lifecycle requests are never labelled as cancellation frames sent.

Prompt ACKs establish started/queued/handled admission, not model completion.
A timeout after dispatch means `unknown`. There is no public result lookup or
retry identity. Inspect `list/read` before deciding whether to submit again;
never automatically replay work to guess whether the operation happened.

Received late ACKs create tracked identity-verification tasks. Runtime and pool
`drainAcks()` wait for received tasks before closing the native child.
ACKs not received do not create an unlimited shutdown wait. Wrong command IDs,
methods, generations or session identities never establish success. A late ACK
does not persist output, create a recovery record or replay a native operation.

Command and stop transfer bounded inline results. A custom bash callback must
return the native output object, not a completion-only acknowledgement.
A stop callback must return `{status:"accepted", acknowledgement, coverage:"agent_and_bash"}`
and report the actual withdrawn text through `onWithdraw`. Optional `onResult`
and `onWithdraw` callbacks publish known output during the same request;
the Bridge retains that prefix if the final ACK is lost. These callbacks do not
create a queryable result. Incomplete bodies are marked honestly, and an unknown
execution outcome remains unknown even when some output is available.
Components must be updated together; no capture-file fallback is supported.

For cooperative host deletion, reserve ownership before opening the writer and
publish callbacks only after it is ready. Release follows three phases:

- Close admission and retire the endpoint.
- Invoke optional `cancel()` to cancel host-owned work, then drain every admitted
  operation, including asynchronous preparation and inline result delivery.
  For an active bash callback without `cancel`, the adapter uses its required
  native `stop` callback before draining.
- Invoke `release()` to close the actual writer and confirm `{released:true}`,
  then release ownership and permit the filesystem move.

A host whose preparation needs cancellation must implement `cancel` rather
than waiting for the final writer-close callback. The host must also fence and
drain its own non-Bridge admissions; adapter tracking alone cannot certify
those. Controller disconnect merely retires its endpoint and retains the live
writer claim. It never kills a shared host.

## Read and fork boundaries

Attached reads select and sanitize at the owner, then transfer a bounded clean
snapshot for Bridge pagination. Owned RPC reads acquire native history before
selection and sanitization. Saved reads use the selected Pi SDK without starting
a writer. Read and fork use separate representations:
image bytes are omitted from reads but preserved in raw fork snapshots.
See [reading](reading.md) for native/observed views, live previews, frozen
cursors and component-mismatch errors.

Live observers accept native text/thinking deltas or cumulative message events.
Tool-result streams and independent bash chunks are not exposed as assistant
text. If native message boundaries change while history is being acquired, the
read omits the preview with `context_changed_during_read`; a fresh read can
observe the new prompt.

Fork uses the cooperative `runtime.snapshot()` operation:
`{sessionFile,sessionId,entries,leafId}`. It contains raw native records, not
the public read projection, and leaves the parent writer in place. Attached
snapshots are limited to 32 MiB; oversized or unsupported current hosts fail
explicitly. There is no disk fallback while a live owner exists.

RPC framing scans each decoded chunk once and joins a fragmented frame at LF.
UTF-8 byte boundaries, CRLF and Unicode line/paragraph separators are preserved;
unfinished EOF frames are discarded. There is no small fixed history-frame
limit or machine-speed assertion.

## Verification

Runtime regressions use synthetic providers, isolated native agent directories
or temporary HOME settings, and native subprocesses/PTYs. They cover release
cancellation plus capture drain, late native bash persistence overlapping
Bridge close, fresh auto-join with ordinary configured extensions/tools,
cancelled handoffs, exact-death cold resume, live partial-to-final reads,
cooperative fork snapshots and unsupported/unreachable owners.
`test/fixtures/faux-extension.mjs` is an offline test provider, never a
production launch dependency.
