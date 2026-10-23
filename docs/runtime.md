# Native runtime, ownership and local entry

The Bridge reuses a cooperating live Pi instance. It starts an RPC child only
when no live registered writer owns the saved session. Ownership includes the
canonical file and exact Linux process identity (PID, process start time and boot
ID). Native session ID, generation and socket metadata bind the current control
endpoint; they are not prerequisites for recognizing a live path owner. A live
but unreachable owner blocks control and cold startup; it never authorizes a
fallback writer.

Registry transactions use one Linux abstract Unix socket derived from the
canonical private IPC directory. The kernel releases this short mutex on process
death; contention has a bounded wait and no lockfile recovery/migration path.
All cooperating processes must share the registry and Linux PID/network
namespaces. Releasing this mutex does not release a session's writer claim:
those claims still require exact process identity and appropriate exit evidence.
Registry scans validate ownership separately from control-interface metadata,
after bounded private reads. Endpoint metadata is checked when accessing live
control, not when recognizing ownership or publishing a native replacement.
A known different target path does not inherit damaged owner fields; ambiguous scope still blocks admission. Old control
metadata cannot turn an exited process into a live writer. Native reload and
replacement publish fresh endpoints using their completed shutdown/start evidence,
not the old control format. Cold startup replaces a dead claim
under the registry mutex, but preserves an explicit local pause.

Using an unsupported live control endpoint reports
`ATTACHMENT_PROTOCOL_MISMATCH`; update the Bridge and companion together at a
safe native reload boundary. Ownership remains blocking while that process is
alive, until exact exit or native replacement ends that claim. A fresh native
registration preserves explicit pauses and existing RPC/host controllers. The
companion records replacement evidence only after closing its listener and draining
admitted mutations. The successor must match the shutdown reason, previous file
and known destination; reload also requires the same native `SessionManager`
instance. A matching successor consumes this process-local evidence once and
retires only that prior context, not other sessions sharing its PID. Without this
evidence, neither PID equality nor a `transitioning` phase ends a live claim;
confirmed process exit remains the other registration boundary. Independent
managers remain distinct writers even when their path and native session ID match.
Rebinding the same active extension runtime retains its endpoint. A same-file
reload outside current scope retains ownership without control or excluded-content
reads; a later paired switch retires that exact claim. Switching away retains a
pause as a released owner record. No old endpoint is translated or
used as a fallback.

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
claims before Pi opens the target and cancels another live writer, including an
independent manager in the same process. Resuming the current native context and
completing this requester's admitted handoff remain allowed.
The current session remains usable; use `/bridge-join` or host coordination for
a managed handoff. This read-only check creates no reservation. It does not make
simultaneous opens atomic or protect initial startup before extension loading;
`session_start` retains its post-open check, and unregistered writers remain
outside the cooperative registry.

## Runtime capabilities

| Capability              | Bridge-owned RPC                              | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings            |
| ----------------------- | --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Read context            | Native + observed                             | Native + observed                                     | Native snapshot; observed unavailable     |
| Live text/thinking      | Native delta events                           | Public extension events                               | When the host supplies live observation   |
| Send text/images        | Native ACK                                    | Submission observable; acceptance unknown             | Native RPC ACK or SDK submission evidence |
| Standalone `set_model`  | Native setters; busy supported                | Public extension setters; busy supported              | Native setters; busy supported            |
| Prompt + model/thinking | Proven-idle only                              | Unsupported                                           | Unsupported                               |
| Native command / stop   | Yes, including queued-input withdrawal        | Unsupported                                           | Yes                                       |
| Manual compact          | Idle by default; explicit interrupt supported | Explicit interrupt; native callbacks                  | Explicit interrupt via native methods     |
| TUI handoff             | Drain and normal EOF, then reserved TUI join  | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                   |

Saved sessions can be read without a runtime. Pi-readable v1/v2 histories are
normalized only in memory through native pure parsing/migration. Malformed
records are skipped as in Pi; `read.history` reports skipped lines and an
unterminated tail. Read never repairs or migrates the file on disk.
Authorized writer open remains responsible for native persistence. Missing or empty native cwd remains readable under session/default permissions; it grants no project scope and cannot cold-start execution.

Authorized send, command, compact or `set_model` can
cold-start an RPC; stop never does. Public `models` reads a separate native agent-configuration catalog without involving an owner or session. `list.status` observes a live owner's current model/thinking, or null when the native selection is unobserved. Current custom hosts declare boolean capabilities from the callbacks they implement.

After public prompt or control work, a Bridge-owned RPC normally exits by EOF once matching
prompt ACKs, native settlement, drained queues and the observer prove idle.
Stop/recovery, in-flight reads and native command output capture finish first. There is no idle timer or new
cold-resume fence: history stays on disk, and a later send resolves ownership
again and may cold-start the same session. Native launch overrides still apply
on every cold start. A send arriving during EOF waits for that exact exit.
Read/list do not reopen a saved session; model catalog queries never acquire or inspect session owners.
Companion TUI/RPC instances and supplied hosts retain their own lifecycle.
On native shutdown/switch, the companion fences admissions and drains its
admitted model setters and manual compaction before allowing a fresh
session_start to retire the old claim. Socket loss does not settle those calls.

Missing ACKs and unfinished native input calls keep the owner alive. Automatic
release drains input preparation, nested native commands, runs, queues, received
ACK checks and native capture. Completed extension input leaves no lasting
uncertainty marker. [Handoff behavior](#handoff-behavior) describes the observation
boundary.

A cold `command` is also eligible for safe release after bash completion; timeout retains the native pending ACK and late completion reevaluates release. A runtime cold-started for `set_model` uses the same safe idle release. Compaction also enables safe release on completion or refusal; a timed-out compaction keeps its native fence until settlement. Catalog queries do not acquire a session owner.

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

`models` reads the native agent-configuration catalog at the Bridge, not through
owner IPC or host callbacks. Owners expose their current model/thinking through
`state`, observed by `list.status`. Prompt model/thinking selection requires an
owned RPC; attached compaction uses native callbacks with explicit interrupt
support. See [native controls](model-control.md) for queue/model timing, default
idle-only compaction and permissions.

### Host model setter

`createSdkHostBinding(session)` uses public `session.setModel()` and
`session.setThinkingLevel()`; `createRpcHostBinding(client)` uses the existing
demultiplexed client's `setModel()` and `setThinkingLevel()`. Neither opens a
session or takes over the owner's pipes.

A custom `reserveHostSession(...).ready(callbacks)` may add:

```text
setModel({model?, thinking_level?, sessionFile, sessionId, beforeDispatch})
  -> Promise<{model:{provider,id}, thinking_level}>
```

`model` and `thinking_level` are optional individually. The host must await its
native setters and report the actual result while keeping the expected session
identity. `beforeDispatch()` checks that the adapter remains open; a concurrent
Stop does not block selection because the setter submits no input.
The adapter independently checks the returned selection against `state()`,
which must expose the current `model` and `thinkingLevel`. It drains an admitted
setter during close/release and fences overlapping settings and send while the
callback is unfinished. Missing callbacks return
`MODEL_SELECTION_UNSUPPORTED`; no catalog callback or new permission is needed.

The RPC host binding observes the public controller's Promise, not its private
response demultiplexer. If that controller times out before Pi finishes a setter,
its ordinary Error cannot reliably distinguish a native rejection from a lost
ACK; Bridge reports uncertainty and never retries it. The exact matching-late-ACK
fence belongs to Bridge-owned RPC, whose demultiplexer it controls. Shared hosts
remain responsible for their own admissions and for closing the actual writer
before confirming release.

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

`pi-installation.mjs` resolves the user's installed Pi once at each acquisition
boundary. `piExecutable` selects an absolute CLI path, including a symlink;
otherwise the launch environment's PATH selects `pi`, with relative PATH entries
resolved from the Bridge/launcher process cwd, not the target project. Its real CLI file identifies
the Pi package, whose declared SDK entry and dependencies supply history parsing,
projection, fork, model discovery, credentials and thinking capabilities. Helpers
receive that resolved SDK path instead of resolving a second package next to Bridge.
Opaque wrappers or executables without the matching SDK fail with
`PI_INSTALLATION_UNAVAILABLE`; missing/non-executable selections fail before launch.
An explicit selection never falls back to PATH. Bridge contains no Pi dependency,
does not install one, and uses the selected installation regardless of its directory location.
Existing cooperating owners are reused without replacing their process. After
upgrading or replacing the selected Pi installation, restart Bridge and reopen
affected Pi owners at a safe boundary: running processes retain loaded native modules.

Pi 1.4.0 is the tested external installation, not a production version override.
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
   Unavailable shutdown UI is reported as a warning after normal exit. Handoff
   does not escalate to process signals.
4. Reserve the target for the requesting TUI **before** `switchSession()`.
   This `handoff` record identifies a future requester, not an actual writer.
5. Change the reservation from `reserved` to `opening` under the registry mutex,
   then invoke native switching. Recheck it in Pi's cancellable pre-open hook.
   Successful `session_start` publishes the real writer and retires its old
   session claims in one registry transaction.

Owner automation should call the handoff protocol directly. Idle-gated controls
and local release share its ACK, queue and settlement checks; completed queued RPC
input does not leave a lasting preflight barrier. New mutations are fenced during
handoff; reads remain available while it waits.

The owned RPC observer counts outstanding calls to Pi's public `prompt`,
`steer`, `followUp` and `sendCustomMessage` methods by native session manager.
It wraps these methods only inside the Bridge-owned child and preserves native
dispatch, results and errors. The observer imports Pi's public package through
the extension loader, which supplies the CLI's own SDK exports even in bundled
installations; a separate SDK-path import would refer to another class.

This covers input hooks before native busy state and nested asynchronous slash
commands started through `sendUserMessage(...,{expandPromptTemplates:true})`,
even after the parent command returns. Each call stops counting when its native
Promise settles, including handled or rejected input. Unrelated run settlement
cannot clear another unfinished call. Counts and sequence numbers survive
extension reload. Private owner-control IPC carries activity notifications;
idle checks also read the child's current counts. Notifications cannot reorder
the counts or permanently substitute a stale state. RPC ACKs, queues and native
run settlement remain separate completion evidence.

The observer does not treat timers or arbitrary extension background jobs as
native input calls. It does not edit Pi's installation or intercept private
dispatch methods. Companions and external hosts retain their own admission and
lifecycle contracts.

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

Reset checks registered owner identity and refuses a live owner, independently
of that claim's control metadata. It cannot
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
Both per-request MCP and SDK tools participate in this drain. Normal task
auto-release still uses EOF alone. Its final synchronous activity check follows
the last ACK/process-identity await. Newly observed work withdraws the temporary
handoff and waits for a later settlement/ACK check instead of closing stdin.

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
consume a response; it no longer waits for the general ACK timeout. After EOF,
shutdown UI cannot consume a response. On normal process exit, handoff and
owner-local release return its methods in `ui.unavailable` as a warning, without
blocking the next reservation or failing the completed release. Native join
displays the warning before switching. A hook may finish through its own timeout
or leave extension cleanup incomplete; the UI diagnostic is separate from writer
ownership. Abnormal exit, identity mismatch and a surviving writer still prevent
handoff. These lifecycle requests are never labelled as cancellation frames sent.

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

## Explicit deletion

Delete is interrupting authority, separate from normal idle release and Bridge
shutdown. It resolves the registry binding directly rather than requiring a
successful read/state attachment. It validates the session header and owner
generation/PID/start/boot before each signal, sends SIGTERM, and escalates to
SIGKILL after `attachmentExitTimeoutMs` (default 5 seconds). The registry mutex
covers each identity check and signal, not the exit wait. Other sessions sharing
that PID prevent process-wide termination; process groups, external parents and
daemons are not inferred termination targets. A changed binding prevents escalation.

Deletion is serialized separately from the ordinary session lane. After preparing
recovery records and fencing new input, it cancels a pending handoff/release.
Under the registry mutex it acquires a session-file deletion gate and observes
the current owner. A transfer completed before this acquisition is included in
the deletion; subsequent writer reservations and handoffs cannot enter. Deletion
then closes that writer without waiting behind the normal lifecycle's exit wait,
drains the session lane, and moves the history while still holding the gate.
There is one termination path, not a second lookup after releasing ownership.
An unopened handoff reservation is revoked without signalling its requester.
For an already-started native switch, deletion keeps the gate and waits for that
one admitted switch to publish its real writer, cancel, or its requester to exit.
Only that exact requester's completion can pass the gate; new acquisitions cannot.
The same delete call then closes the writer and moves the history. Pi's public
switch hook is not an atomic cancel/open boundary: if switching hangs permanently
or throws without confirming cancellation or publishing a writer, deletion may
remain waiting until the requester exits. There is no timeout-based permission
to kill a process that may still be using another session.

Pending RPC startup is cancellable before launch. Once launched, its exact
identity is available before native readiness, so deletion can terminate it even
when startup failure cleanup is waiting for an unresponsive Pi. Startup promises
are drained only after deletion has exercised its termination authority.

The gate uses the existing process-owned kernel lock mechanism. It does not
replace the writer claim, hold the registry mutex during exit, or create a
persistent deletion record. Other sessions continue independently, existing
owners can finish their release, and Bridge death releases the gate.
A failed move leaves the prior cold-resume pause intact. Once the file has moved,
cleanup removes that pause before releasing the gate, even if a later directory
sync reports an uncertain durability result.

For a Bridge-created Herdr scope, explicit delete also terminates its remaining
worker/tool descendants, escalating after the same grace period. Ordinary EOF,
handoff and service shutdown retain their non-escalating behavior.

Only confirmed writer exit or a successful session-local host release permits
the trash move. While the deletion gate excludes new acquisitions, removal of
the writer claim or its same-generation released state confirms closure even
when the release ACK is lost; the shared host PID need not exit. An unexpected
binding change is not authority to signal an unverified process. Recovery records
are prepared before interruption, and the original file identity is checked again
before rename.

For session-local host deletion, reserve ownership before opening the writer and
publish callbacks only after it is ready. Release follows three phases:

- Close business admission and mark the owner as transitioning. Matching
  release controls remain reachable.
- Invoke optional `cancel()` to cancel host-owned work, then drain every admitted
  operation, including asynchronous preparation and inline result delivery.
  An active bash uses `stop` only when no `cancel` callback exists. Command
  support therefore requires bash and either cancellation callback, not the
  complete remote stop interface.
- Invoke `release()` to close the actual writer and confirm `{released:true}`,
  then release ownership and permit the filesystem move.

A failed cancel or release keeps business admission closed and ownership intact.
Concurrent release calls share the pending attempt; an explicit local release or
later authorized delete can retry unfinished close steps. Once the host confirms
writer closure, a retry only finishes registry cleanup. Host callbacks must be
able to resume or confirm closure on an explicit retry after a failure. There is
no automatic retry, business replay or reopening of admission.

A host whose preparation needs cancellation must implement `cancel` rather
than waiting for the final writer-close callback. The host must also fence and
drain its own non-Bridge admissions; adapter tracking alone cannot certify
those. Controller disconnect merely retires its endpoint and retains the live
writer claim. It never kills a shared host. Unsupported, failed or unreachable
release does not veto deletion of a dedicated writer: Bridge terminates its
verified process instead. A shared host without a working session-local close
path reports `DELETE_SHARED_OWNER`; forcibly killing it would also destroy its
neighbor sessions.

## Read and fork boundaries

Owned RPC and attached reads select and sanitize at the owner, then transfer a
bounded clean snapshot for Bridge pagination. Saved reads use the selected Pi
SDK without starting a writer. Read and fork use separate representations:
image bytes are omitted from reads but preserved in raw fork snapshots.
See [reading](reading.md) for native/observed views, live previews, frozen
cursors and component-mismatch errors.

Live observers accept native text/thinking deltas or cumulative message events.
Tool-result streams and independent bash chunks are not exposed as assistant
text. The owned observer captures the native projection and live preview
together, so a later prompt cannot donate its live output to an earlier capture.

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
