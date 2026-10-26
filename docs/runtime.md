# Native runtime, ownership and local entry

Start with a working [owner configuration](configuration.md) and
[MCP connection](transports.md). A **session** is a saved native Pi history;
its **owner** is the live process permitted to write it. The MCP client and the
Bridge service are separate from that writer.

Choose the entry path that matches how you use Pi:

| Starting point                                               | Setup                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Saved session with no live owner                             | No manual attachment is needed. An authorized execution call can cold-start a Bridge-owned RPC.    |
| Daily Pi TUI or an ordinary RPC owned by another application | [Load the companion](#daily-tui-and-ordinary-rpc-registration) using the same owner configuration. |
| A host application integrating the public SDK/RPC APIs       | Follow the [host registration lifecycle](#host-registration-lifecycle).                            |
| Open a session currently controlled by Bridge in a terminal  | Use the [native launcher](#open-a-bridge-session-in-a-native-terminal), which negotiates handoff.  |

Registration makes an owner reachable; [permissions](configuration.md) still
decide which operations a remote caller may perform. The capability table below
describes implementation support, independently of those grants.

## Ownership and cooperating writers

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

| Capability              | Bridge-owned RPC                     | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings          |
| ----------------------- | ------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| Read context            | Session + runtime                    | Session + runtime                                     | Session projection; runtime unavailable |
| Live text/thinking      | Native delta events                  | Public extension events                               | When supplied by the host               |
| Send text/images        | Native ACK                           | Confirmed dispatch; admission unobservable            | Native RPC ACK or SDK dispatch evidence |
| Standalone `set_model`  | Native setters; busy supported       | Public setters; busy supported                        | Native setters; busy supported          |
| Prompt + model/thinking | Proven-idle only                     | Unsupported                                           | Unsupported                             |
| Native command / stop   | Including queued-input withdrawal    | Unsupported                                           | Yes                                     |
| Manual compact          | Idle by default; explicit interrupt  | Explicit interrupt                                    | Explicit interrupt                      |
| Reload                  | Idle refresh through owned lifecycle | Native resource reload when idle                      | SDK native reload; RPC host callback    |
| TUI handoff             | Drain, normal EOF, reserved join     | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                 |
| Completion events       | Native settlement                    | Native settlement with the owner profile              | Unsupported                             |

The host column describes the supplied bindings; a custom host exposes only the
callbacks it implements. In particular, an RPC host must provide its own reload
callback. Use `list.status.capabilities` to inspect a connected owner's advertised
send, command, stop and reload support.

Saved reads need no writer. Send, command, compact and `set_model` may cold-start
an RPC; reload, stop, read, search and list do not. Model catalogs are independent of session
owners. See [native controls](model-control.md) and [read formats](reading.md).

After prompt/control work, an owned RPC normally follows the
[idle shutdown contract](#shutdown-and-in-flight-acks) before EOF.
ACKs, native settlement, queues and observed input preparation must establish
idle; in-flight reads, Stop recovery and command-output capture finish first.
Missing ACKs or unfinished input calls retain ownership. There is no idle timer;
later work resolves ownership again and may cold-start the saved session. Bridge
input arriving during committed shutdown waits for that exact exit. Companion and host
lifecycles remain local.

Command timeouts retain their pending ACK; late completion reevaluates release.
Cold `set_model` and completed/refused compaction use the same safe release path;
timed-out compaction keeps its native fence until settlement. On companion
shutdown/switch, admission closes and admitted setters/compaction drain before
fresh registration can retire the claim. Socket loss does not settle those calls.

The ordinary companion reports `dispatched, admission:"unobservable"` after
a successful `sendUserMessage()` invocation, and `BASH_UNSUPPORTED` / `STOP_UNSUPPORTED` for controls it
cannot implement. Native command support must use Pi's bash path, including
`user_bash`, history and cancellation. Custom hosts declare capabilities from
the callbacks they implement; command requires bash plus either cancel or stop,
while remote stop requires the complete stop callback.

The [send modes](api.md#send) use native steering/follow-up queues. For companions
and SDK bindings, `idle_only` also checks unfinished public SDK calls, including
input preparation, before invoking Pi. Remote companion/host inputs refuse
`/bridge-join` and collision aliases; join remains owner-local.

## Remote reload

[`reload({session_id})`](api.md#reload) uses `send` permission and acts only on an
active owner. `list.status.capabilities.reload` reports support. Busy work is refused, including pending input and admitted control
operations; there is no interrupt option or deferred reload. A saved session is
left saved, and an explicit local pause remains in force.

An ordinary companion invokes Pi's native resource reload. Its old endpoint
closes during `session_shutdown`; the claim continues blocking other writers
until `session_start` publishes a fresh ready generation for the same session.
Bridge confirms that registration, waits for the native reload handler to finish,
and reports its component version. The companion observes public SDK operation
lifetimes so asynchronous input preparation and standalone bash also block reload;
new operations are refused while resources are being replaced. A closed
socket or an input acknowledgement alone is not completion evidence. An owned
RPC follows the [idle shutdown contract](#shutdown-and-in-flight-acks), then starts
a fresh worker with current resources. Lifecycle cancellation after seal dispatch
does not undo shutdown, but prevents the reload successor from starting. Native
shutdown/startup hooks are allowed to finish; Bridge does not kill them on a timer.

Reload preserves saved messages and resets extension-local state, including the
previous Runtime Context capture. It reads the owner's configured resources;
it does not rewrite extension paths. A successful reload can therefore return
`read_compatible:false` when those paths still select an older Bridge component.

SDK host bindings call the existing session's `reload()` and use the same native
operation guard as companions. Create the binding before accepting local input so
the guard observes input preparation as well as model execution. Their controller
and writer remain in place; completion is the resolved native reload, not a new owner generation. Other
sessions sharing the host process remain untouched. The adapter reports its own
loaded Bridge version because native resource reload does not reimport host code.

Native Pi RPC has no reload command. `createRpcHostBinding(client, { reload })`
therefore accepts the host's native reload callback. Custom host adapters can
provide the same callback in `ready(callbacks)`:

```text
reload({sessionFile, sessionId, beforeDispatch}) -> Promise<{reloaded:true}>
```

The callback checks idle and fences every local admission path, including input
preparation, then calls `beforeDispatch()` immediately before native reload.
Resolve only after that reload finishes, preserving the current writer and native
session identity. The adapter fences its own mutations while waiting. A command
ACK is not completion; an exception after dispatch is an unknown outcome. Missing
a callback is reported by `list.status.capabilities.reload:false`.

Inspire currently owns ordinary Pi RPC workers that load the companion, so it
uses the companion path directly. Bridge reload runs inside that worker; it does
not restart Inspire or replace the worker. Inspire's local `/reload` action is a
separate host-managed worker reopen.

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

For model-only changes, preserve the effort current before switching and use the
native thinking setter for compatible fallback. Await the native setters, retain
expected session identity and return the actual selection. `beforeDispatch()`
checks adapter admission; Stop does not block this input-free control. The adapter checks the result against `state()`, drains an
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

First confirm that the owner configuration's `sessionRoots` includes the native
session location and grants the intended operations. Loading the companion does
not grant access by itself. Use the same installed Bridge checkout as the service;
the running components must implement the current control interface.

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
use an owner profile for scoped daily access and [completion events](events.md).

Existing processes need a safe TUI `/reload` or host-managed reopen to load a
newly configured extension. Registration happens after native file open, so it
cannot make blindly launching `--session` into an owned file safe. A GUI started
first can expose its Pi through the companion; one opened after a Bridge-owned
RPC needs shared control or an explicit handoff.

After loading, check the owner status with `list({session_id})` through the
running Bridge. A fresh native session appears in discovery only after Pi
persists it. For an active in-scope session, `saved` means no cooperating live
owner was found; `unavailable` or a protocol mismatch needs investigation before
sending work.
See [runtime capabilities](#runtime-capabilities) for the operations registration
provides and [events](events.md) for notification setup.

## Host registration lifecycle

Use `reserveHostSession` from `src/host-adapter.mjs` when an application controls
the actual writer. `createSdkHostBinding` and `createRpcHostBinding` from
`src/host-bindings.mjs` adapt existing public APIs; they do not open sessions,
spawn Pi, or take over an RPC client's stdio.

1. Before opening the target, reserve its canonical `session:{file,header}` in
   the Bridge's `attachmentDir`. Supply `owner` from `processIdentity(writerPid)`
   for an RPC child; the default identity is the current process, suitable for an
   in-process SDK writer. A separate RPC child can start without a session before
   reservation, then switch to the reserved target.
2. Open the target through the host's native API. Create the SDK binding before
   admitting local input so its operation observer can track input preparation.
   Pass `piExecutable` to `reserveHostSession` when the selected Pi installation
   is not the one resolved from the host's PATH.
3. Publish with `await controller.ready(binding)` once `state()` and `snapshot()`
   describe the reserved session. Keep the native writer under the host's
   lifecycle control and the controller bound to that session. A session change
   needs a new reservation and the release contract below, not reuse of a
   controller with a different native identity.
4. If remote release is supported, provide a `release` callback that fences local
   admission, aborts/drains all session work and closes the actual writer before
   returning `{released:true}`. `controller.close()` disconnects the adapter; it
   does not establish that a still-live writer has released the file.

Custom callbacks follow the same identity and lifecycle requirements. Model,
compaction and reload contracts appear above; command/stop result callbacks are
described under [shutdown and in-flight ACKs](#shutdown-and-in-flight-acks).
[Host integration tests](../test/host-integration.test.mjs) demonstrate the SDK
and RPC reservation sequences with isolated synthetic sessions.

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
3. Complete [idle shutdown](#shutdown-and-in-flight-acks): seal
   new work in the child, close stdin after confirmation and observe that exact
   child's normal exit. Handoff sends no process signals; unavailable shutdown
   UI is a warning after exit.
4. Reserve the target for the requester before `switchSession()`. The reservation
   identifies a future requester, not a writer.
5. Under the registry mutex change `reserved` to `opening`, then invoke native
   switching and recheck the reservation in the cancellable pre-open hook.
   Successful `session_start` publishes the writer and retires its prior claims
   in one transaction.

Owner automation should use this protocol directly. Idle-gated controls and
local release share its completion checks; reads remain available while waiting
for idle.
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
that work finishes. Cancellation before seal dispatch restores admission. After
dispatch it does not withdraw seal confirmation or confirmed shutdown, but
prevents reserving or opening the destination. Returned cancellation before
native open removes the reservation and permits an explicit retry.
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

This fences mutations and follows the
[idle shutdown contract](#shutdown-and-in-flight-acks), including
EOF and exact exit. The pause remains until a cooperative join or reset. To
authorize interruption of running/unobservable preparation work:

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

Normal auto-release, idle local release, handoff and owned RPC reload use the
same non-interrupting shutdown contract. After pending acknowledgements and
captures drain, Bridge asks the matching child observer to check its actual
native activity and permanently close admission to new business work. The child
checks idle and commits this terminal seal synchronously, with no asynchronous
gap between them. A busy child refuses without sealing; auto-release leaves it
open and waits for later settlement. Parent-side cached activity alone cannot
authorize EOF.

The current native idle interface omits queued `deliverAs:"nextTurn"` custom
messages and a same-file resume in progress. Owned idle shutdown can therefore
discard that queued context or lose its seal during session replacement. These
two cases need native queue and lifecycle visibility before this contract can
protect them.

Already admitted reads finish before sealing. A new capture racing with local
release, handoff or reload may return `RUNTIME_SHUTTING_DOWN`; retry after that
lifecycle operation completes. Frozen cursors remain subject to their normal
identity and permission checks.

Once sealed, the child rejects new business work, including work requested by
shutdown hooks. Hooks may still record cleanup state without starting new work.
Bridge sends EOF only after confirming the seal for the same session and owner
generation, then observes that exact child's normal exit before releasing its
claim. This path sends no process signals. Sealing does not clear an explicit
`noColdReacquire` pause.

A lost or uncertain seal acknowledgement preserves the owner, claim and admission
fence; it is not permission to send EOF or start another writer. An explicit
shutdown retry can confirm or complete closure of that same generation without
replaying business input. Lifecycle cancellation after seal dispatch does not
cancel its confirmation or undo a committed seal. Confirmed shutdown still
finishes, while cancellation prevents a handoff reservation or reload successor
from being created. Existing explicit local pauses remain in force.

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
unknown outcome; query the returned `submission_id` for a late ACK before deciding
on another independent call. The bounded receipt cache has no replay or durable
journal. Received late ACKs create tracked identity checks and update that receipt;
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
[Reading](reading.md) defines brief/full selection, search, references and frozen capture behavior.

Fork uses `{sessionFile,sessionId,entries,leafId}` from the cooperating owner's
`snapshot()` while leaving its writer in place. These raw native records retain
state and image bytes excluded from public reads. Attached snapshots are bounded
at 32 MiB; oversized/unsupported hosts fail rather than falling back to disk
while a live owner exists. Owned fork uses native `get_entries`.

## Verification

See [verification commands](architecture.md#verification). Runtime fixtures use
isolated native environments and synthetic providers; the offline fixture
extension is not a production dependency.
