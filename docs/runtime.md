# Native runtime, ownership and local entry

Bridge reuses a cooperating live Pi instance and starts an RPC child only when
no live registered writer owns the saved session. Ownership binds the canonical
file to an exact Linux process: PID, process start time and boot ID. Native
session ID, generation and socket metadata identify its control endpoint. A live
but unreachable owner still blocks cold startup.

Registry transactions use a short kernel-owned mutex derived from the canonical
private IPC directory. All cooperating processes must share this directory and
Linux PID/network namespaces. Process death releases the mutex; writer claims
separately require exact exit or completed native replacement evidence. Ownership
is checked independently of endpoint compatibility: damaged fields for a known
different path do not block the target, ambiguous scope does, and obsolete control
metadata cannot revive an exited writer.

An unsupported live endpoint reports `ATTACHMENT_PROTOCOL_MISMATCH`; update
Bridge and its companion/host at a safe native reload boundary. A native
replacement registers a fresh endpoint after closing its old listener and
draining admitted mutations. Its shutdown reason, previous file and destination
must match; reload also requires the same `SessionManager`. This process-local
evidence is consumed once and retires only that context. PID equality or a
`transitioning` phase alone does not end ownership: independent managers remain
separate writers even with the same path and native ID. Rebinding the same
active extension retains its endpoint.

Fresh registration preserves explicit local pauses and existing RPC/host
controllers. A same-file reload outside current scope retains ownership without
exposing control or reading excluded content; a later paired switch retires that
claim. Switching away preserves a pause as a released record. Dead claims can
be replaced under the registry mutex, but an explicit pause still needs the
[local reset procedure](#recover-an-explicit-local-pause).

The registry covers cooperating processes. An unregistered RPC has no generic
attach-by-PID path: its original host must load a companion/controller or close
it before reopening. Multiple MCP clients should share one Bridge service;
independent Bridge services cannot share private RPC pipes.

An owned RPC is bound to its reserved file. Its observer cancels native
new-session, fork and cross-file resume before the target opens; use Bridge
create/fork or a host that manages cross-session ownership. Identity mismatches
reject operations and invalidate scoped events without stopping the process.

Ordinary companions check target-path claims before native resume and cancel
entry into another live writer, including one in the same process. Current-context
resume and the requester's admitted handoff remain allowed. This read-only check
creates no reservation, so it cannot make concurrent opens atomic or protect
startup before extension loading. `session_start` also checks ownership after
open. Use `/bridge-join` or host coordination for a managed handoff.

## Runtime capabilities

| Capability              | Bridge-owned RPC                    | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings            |
| ----------------------- | ----------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Read context            | Native + observed                   | Native + observed                                     | Native snapshot; observed unavailable     |
| Live text/thinking      | Native delta events                 | Public extension events                               | When supplied by the host                 |
| Send text/images        | Native ACK                          | Submission observable; acceptance unknown             | Native RPC ACK or SDK submission evidence |
| Standalone `set_model`  | Native setters; busy supported      | Public setters; busy supported                        | Native setters; busy supported            |
| Prompt + model/thinking | Proven-idle only                    | Unsupported                                           | Unsupported                               |
| Native command / stop   | Including queued-input withdrawal   | Unsupported                                           | Yes                                       |
| Manual compact          | Idle by default; explicit interrupt | Explicit interrupt                                    | Explicit interrupt                        |
| TUI handoff             | Drain, normal EOF, reserved join    | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                   |

Saved reads need no writer. Send, command, compact and `set_model` may cold-start
an RPC; stop, read and list do not. Model catalogs are independent of session
owners. See [native controls](model-control.md) and [read formats](reading.md).

After prompt/control work, an owned RPC normally exits by EOF once ACKs, native
settlement, drained queues and observed input preparation establish idle.
In-flight reads, Stop recovery and command-output capture finish first. Missing
ACKs or unfinished input calls retain ownership. There is no idle timer; later
work resolves ownership again and may cold-start the saved session. Input arriving
during EOF waits for that exact exit. Companion and host lifecycles remain local.

Command timeouts retain their pending ACK; late completion reevaluates release.
Cold `set_model` and completed/refused compaction use the same safe release path;
timed-out compaction keeps its native fence until settlement. On companion
shutdown/switch, admission closes and admitted setters/compaction drain before
fresh registration can retire the claim. Socket loss does not settle those calls.

The ordinary companion reports `PI_ACCEPTANCE_UNOBSERVABLE` after
`sendUserMessage()` and `BASH_UNSUPPORTED` / `STOP_UNSUPPORTED` for controls it
cannot implement. Native command support must use Pi's bash path, including
`user_bash`, history and cancellation. Custom hosts declare capabilities from
the callbacks they implement; command requires bash plus either cancel or stop,
while remote stop requires the complete stop callback.

Default send follows TUI Enter and steers while busy; follow-up uses Pi's follow-up
queue and native consumption modes. Idle-only checks both busy state and pending
queues, plus unfinished SDK prompt promises including input preparation. It skips
busy work instead of queueing it. Remote companion/host inputs refuse
`/bridge-join` and collision aliases; join remains owner-local.

## Model settings and compaction

Owners expose current `model` and `thinkingLevel` through `state`, used by
`list.status`. The separate catalog and public control semantics are defined in
[model control](model-control.md); hosts implement these callbacks against their
existing writer.

### Host model setter

The supplied SDK binding uses public `setModel()` / `setThinkingLevel()`; the
RPC binding uses those methods on the owner's existing demultiplexed client.
A custom `reserveHostSession(...).ready(callbacks)` may add:

```text
setModel({model?, thinking_level?, sessionFile, sessionId, beforeDispatch})
  -> Promise<{model:{provider,id}, thinking_level}>
```

Await the native setters, retain expected session identity and return the actual
selection. `beforeDispatch()` checks adapter admission; Stop does not block this
input-free control. The adapter checks the result against `state()`, drains an
admitted setter during close/release, and fences overlapping settings/send until
settlement. Missing support reports `MODEL_SELECTION_UNSUPPORTED`.

An ordinary RPC-controller timeout cannot reliably distinguish native rejection
from a lost ACK. The binding reports uncertainty without retrying; exact late-ACK
tracking belongs to Bridge-owned RPC. Hosts remain responsible for their own
admissions and must close the actual writer before confirming release.

### Host compact callback

A custom host may implement
`compact({instructions?,interrupt?,sessionFile,sessionId,beforeDispatch})` against
its existing native writer. With `interrupt:false`, it must establish idle through
its own admission gate. Call `beforeDispatch()` immediately before native dispatch
and resolve with the native result only after compaction completes. The adapter
blocks overlapping input/compaction and drains admitted work during release.
Public control results expose bounded metadata; summary and native details require
history `read`.

## Image-capable owners

Images pass through native RPC prompt arguments, SDK prompt options or companion
`sendUserMessage()` content blocks. [Image input](api.md#image-input-send-and-create)
defines payloads and limits.

The companion advertises `imagesSupported:true`; supplied host bindings declare
`supportsImages:true`. A custom host must declare support and forward
`submit().images` to its native API. Omission keeps text working but rejects images.
Updating files takes effect only after the running owner reloads or reopens.

## Daily TUI and ordinary RPC registration

Add the installed companion's canonical path to Pi's existing settings
(`~/.pi/agent/settings.json`, or the selected `PI_CODING_AGENT_DIR`), preserving
other extensions/settings:

```json
{
  "extensions": ["/absolute/pi-mcp-bridge/src/attach-extension.mjs"]
}
```

Use the same file as the installation's `open.mjs`; Pi deduplicates a settings
entry and explicit `-e` for that canonical file. In a Bridge-owned child the
companion defers to the existing RPC claim instead of publishing another endpoint.

The daily companion reads
`$XDG_CONFIG_HOME/pi-mcp-bridge/owner.json`, otherwise
`$HOME/.config/pi-mcp-bridge/owner.json`; `PI_MCP_OWNER_CONFIG` selects another
file. An absent default leaves it inactive. An explicitly selected missing,
invalid or non-private file reports an extension-load error.

It uses the configured registry and registers only sessions under `sessionRoots`,
checking path metadata before reading native headers/entries. No-session or
out-of-scope runs get no endpoint. A fresh session may reserve its identity before
first persistence; discovery begins when Pi writes the file. Reload publishes a
fresh generation and switch-away retires that context's claim.
[Configuration](configuration.md#request-permission-snapshots) defines scope
updates and permissions.

An ordinary RPC host sharing the native agent directory inherits the companion.
The host retains its pipes and lifecycle; Bridge uses private IPC. For a one-off
launch with the same owner scope:

```sh
PI_MCP_OWNER_CONFIG=/absolute/path/owner.json \
pi -e /absolute/pi-mcp-bridge/src/attach-extension.mjs
```

If also set, `PI_MCP_ATTACH_DIR` must agree with the owner file. Directory-only
`PI_MCP_ATTACH_DIR` is the low-level path for hosts managing their own scope;
use an owner profile for scoped daily access.

Existing processes need a safe TUI `/reload` or host-managed reopen to load a
newly configured extension. Registration happens after native file open, so it
cannot make blindly launching `--session` into an owned file safe. A GUI started
first can expose its Pi through the companion; one opened after a Bridge-owned
RPC needs shared control or an explicit handoff.

## Open a Bridge session in a native terminal

With the owner Bridge running:

```sh
node src/open.mjs /absolute/path/owner.json ps_SESSION_ID
```

The launcher finds the recorded project and starts a fresh native TUI with the
companion and initial `/bridge-join ps_SESSION_ID` command. It uses the owner's
[native launch profile](configuration.md#native-environment), supplying
`PI_MCP_OWNER_CONFIG` and `PI_MCP_ATTACH_DIR`.

The launcher cannot start with `--session TARGET`: native open/migration precedes
extension loading and ownership negotiation. `piArgs --session-dir DIR` may set
the fresh session's storage directory; existing-session selectors (`--session`,
`--session-id`, `--continue`, `--resume`, `--fork`) and noninteractive arguments
reject. An already-running companion TUI can invoke `/bridge-join` manually.

### Handoff behavior

1. Fence Bridge input and wait for admitted Stop recovery.
2. Check ACKs, native busy/queue/settlement state and observed input preparation.
3. Close owned RPC stdin and observe that exact child's normal exit. Handoff
   sends no process signals; unavailable shutdown UI is a warning after exit.
4. Reserve the target for the requester before `switchSession()`. The reservation
   identifies a future requester, not a writer.
5. Under the registry mutex change `reserved` to `opening`, then invoke native
   switching and recheck the reservation in the cancellable pre-open hook.
   Successful `session_start` publishes the writer and retires its prior claims
   in one transaction.

Owner automation should use this protocol directly. Idle-gated controls and
local release share its completion checks; reads remain available while waiting.
The owned observer counts outstanding public `prompt`, `steer`, `followUp` and
`sendCustomMessage` calls by native session manager. This covers input hooks and
nested asynchronous slash commands, including calls continuing after a parent
command returns. Each native Promise settles its own count; unrelated run
settlement cannot clear it. Counts survive extension reload and ordered IPC
notifications are checked against current child state. ACKs, queues and run
settlement remain separate evidence. Arbitrary extension timers/background jobs
are outside this observation.

The fresh TUI shows wait/failure notifications without mirroring old RPC output.
Ctrl+Alt+J cancels; unrelated work in the fresh TUI causes join to refuse until
that work finishes. Cancellation before EOF restores admission; after EOF it
allows shutdown to finish without opening the destination. Returned cancellation
before native open removes the reservation and permits an explicit retry.
A thrown, possibly partial switch retains the requester's claim until exact exit.

A successful switch-away retires the old context's claim; later destination exit
cannot pause it. Closing a TUI ends its running work, while dead registered owners
may cold-resume saved history. Live unreachable owners or unavailable identity
still block startup.

### Recover an explicit local pause

Owner-local release keeps `noColdReacquire` for a possible unregistered manual
writer. To clear it:

1. Close the original writer and any unregistered Pi using the target.
2. Confirm local closure through the running Bridge:

   ```sh
   node src/owner-runtime.mjs /absolute/path/owner.json reset ps_SESSION_ID --confirm-local-closed
   ```

3. Retry join or send a new authorized prompt.

Reset refuses any registered live owner regardless of endpoint compatibility.
The explicit confirmation covers unregistered writers the registry cannot see;
deleting a claim does not establish closure.

For deliberate idle release without opening a TUI:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json release ps_SESSION_ID
```

This fences mutations, proves idle and waits for EOF exit. The pause remains until
a cooperative join or reset. To authorize interruption of running/unobservable
preparation work:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json release ps_SESSION_ID --interrupt
```

The private control verifies the captured child, generation and PID/start/boot,
including a child already exiting after EOF, then sends SIGTERM and waits. It
neither escalates to SIGKILL nor terminates a shared companion/host. Saved history
remains; unfinished memory-only work may be lost. A client timeout does not cancel
requested exit or release ownership. Failed delivery can be retried explicitly.

Either release form can close a known owned child after its history file was
removed, using captured identity and claim. Replacement or unsafe files still
fail validation. After closing all local writers, reset permits cold resume.

## Shutdown and in-flight ACKs

Transport shutdown freezes admission, cancels local handoffs and interrupts owned
writers already exiting by EOF before draining requests. Dispatched inputs,
reads and received ACK checks finish before remaining runtimes close. Queued
operations may return `BRIDGE_CLOSING`; shutdown never starts replacement work.
Both per-request MCP and SDK tools participate. Shutdown waits for SIGTERM exit
without automatic SIGKILL; a process manager's independent stop timeout applies.

Normal auto-release uses only EOF. Its final synchronous activity check follows
the last ACK/identity await; newly observed work withdraws the temporary handoff
and waits for later settlement.

Headless RPC replies `extension_ui_response {cancelled:true}` to `confirm`,
`select`, `input` and `editor` dialogs. An admitted send/create reports
`EXTENSION_UI_CANCEL_SENT` when a cancellation frame was sent; Pi does not ACK
its consumption. Diagnostics record the method/code without dialog content.
Notifications and extension errors appear in
[`read.runtime_events`](reading.md#live-output-and-runtime-extension-events);
other display-only requests are ignored.

Before the first readiness ACK, an interactive dialog reports
`EXTENSION_UI_STARTUP_UNAVAILABLE`: awaited `session_start` UI precedes Pi's stdin
reader. After EOF, dialogs also cannot consume responses. Once the process exits
normally, handoff/release reports methods in `ui.unavailable` and may proceed;
join shows the warning before switching. A hook can time out or leave cleanup
unfinished, but abnormal exit, identity mismatch or a surviving writer still
blocks handoff. These unavailable-dialog cases are distinct from sent cancellation.

Prompt ACKs establish admission, not model completion. Dispatch timeout means an
unknown outcome; inspect `list/read` before deciding on another independent call.
There is no automatic replay. Received late ACKs create tracked identity checks;
`drainAcks()` waits for those tasks, not indefinitely for absent ACKs. Wrong IDs,
methods, generations or native identities cannot establish success.

Command/stop deliver bounded inline results. A custom `bash` callback returns the
native output object. A `stop` callback returns
`{status:"accepted",acknowledgement,coverage:"agent_and_bash"}` and reports actual
withdrawn text through `onWithdraw`. Optional `onResult`/`onWithdraw` publish known
output on the same request; Bridge retains that prefix if the final ACK is lost.
Incomplete output and uncertain execution are reported independently. These
callbacks do not create a later result lookup.

## Explicit deletion

Delete authorizes interruption independently of idle release and shutdown. It
validates the native header and registry generation/PID/start/boot before each
signal, sends SIGTERM, then escalates to SIGKILL after `attachmentExitTimeoutMs`
(default 5 seconds). A successful read/state endpoint is unnecessary. Identity
checks/signals hold the registry mutex; exit waits do not. A changed binding stops
escalation. Other sessions sharing the PID forbid process-wide termination;
external parents, process groups and daemons are not inferred targets.

Deletion uses a separate lane and a process-owned session-file gate:

1. Prepare recovery records, fence input and cancel a pending handoff/release.
2. Acquire the gate under the registry mutex and observe the current owner. A
   transfer completed before this point is included; new acquisitions cannot enter.
3. Close the writer, drain the ordinary session lane, recheck file identity and
   move history to private trash while retaining the gate.

An unopened handoff reservation is revoked without signalling its requester.
An admitted native switch must finish, cancel or lose its requester before the
same delete call continues; only that requester's completion can pass the gate.
Pi has no atomic cancel/open boundary, so an indefinitely stuck or uncertain switch
can leave deletion waiting until requester exit. A timeout does not authorize
killing a process that may still use another session.

Startup can be cancelled before launch. After launch, captured identity permits
delete before readiness, even when startup cleanup is waiting for Pi. Startup
promises drain after termination. The gate does not replace the owner claim or
hold the registry mutex during exit; other sessions proceed and Bridge death
releases it. A failed move preserves the prior cold-resume pause. Once moved,
cleanup clears the pause even if a later directory sync reports uncertain durability.
Bridge-created Herdr scopes also terminate remaining worker/tool descendants with
the same escalation budget; ordinary EOF, handoff and shutdown do not escalate.

The trash move requires confirmed writer exit or a successful session-local host
close. Under the gate, removal of the claim or its same-generation released state
confirms closure even if the release ACK was lost; a shared host PID need not exit.
An unexpected binding change grants no signalling authority.

A host must reserve ownership before opening its writer and publish callbacks only
after readiness. Session-local release follows these phases:

1. Close business admission and mark the owner transitioning, keeping matching
   release controls reachable.
2. Invoke optional `cancel()` and drain all admitted operations, including input
   preparation and inline result delivery. Active bash uses `stop` only when no
   cancel callback exists.
3. Invoke `release()` to close the actual writer, confirm `{released:true}`, then
   release the claim and permit the filesystem move.

Failed cancel/release leaves admission closed and ownership intact. Concurrent
release calls share the pending attempt; later explicit release or authorized
delete may retry unfinished steps. After writer closure, retries only finish
registry cleanup. Callbacks must resume or confirm closure on retry without
replaying business work or reopening admission.

Hosts with cancellable preparation must implement `cancel` rather than waiting
for writer-close, and must fence/drain their own non-Bridge admissions. Controller
disconnect retires only its endpoint, preserving the live claim. Failed, absent
or unreachable release does not veto delete of a dedicated writer: Bridge may
terminate its verified process. A shared host lacking a working session-local
close path returns `DELETE_SHARED_OWNER` to protect its other sessions.

## Read and fork boundaries

Owner reads transfer selected, sanitized snapshots; saved reads need no writer.
[Reading](reading.md) defines selection, capture and cursor behavior.

Fork uses `{sessionFile,sessionId,entries,leafId}` from the cooperating owner's
`snapshot()` while leaving its writer in place. These raw native records retain
state and image bytes excluded from public reads. Attached snapshots are bounded
at 32 MiB; oversized/unsupported hosts fail rather than falling back to disk
while a live owner exists. Owned fork uses native `get_entries`.

## Verification

See [verification commands](architecture.md#verification). Runtime fixtures use
isolated native environments and synthetic providers; the offline fixture
extension is not a production dependency.
