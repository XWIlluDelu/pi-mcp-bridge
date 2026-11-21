# Native runtime, ownership and local entry

A **session** is a saved native Pi history. Its **owner** is the process permitted to write it.

| Starting point                                               | Setup                                                                                              |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Saved session with no live owner                             | No manual attachment is needed. An authorized execution call can cold-start a Bridge-owned RPC.    |
| Daily Pi TUI or an ordinary RPC owned by another application | [Load the companion](#daily-tui-and-ordinary-rpc-registration) using the same owner configuration. |
| A host application integrating the public SDK/RPC APIs       | Follow the [host registration lifecycle](#host-registration-lifecycle).                            |
| Open a session currently controlled by Bridge in a terminal  | Use the [native launcher](#open-a-bridge-session-in-a-native-terminal), which negotiates handoff.  |

## Ownership and cooperating writers

Every cooperating process uses the same canonical private registry and shares
Linux PID and network namespaces. A writer claim binds a canonical file to a
verified process identity (PID, process start and boot ID from `/proc`).
Native ID, generation and socket bind its endpoint. Live or uncertain claims
block new writers through socket loss and component mismatches. The registry
mutex uses an abstract Unix socket and has a separate lifetime from the claim.

A matching native reload or switch may retire only its own context after draining
mutations and closing the old listener. The shutdown reason, previous file and
destination must agree. Reload also requires the same SessionManager. PID
equality does not identify independent managers. Switching away preserves an
explicit pause, including when the old session has left configured scope.

An owned RPC vetoes native new, fork and cross-file resume before open.
Companions check target claims before native resume and again at registration.
Use Bridge create/fork, local handoff or explicit host reservation for coordinated
entry. An unregistered process needs its own companion/controller or a local
close before reopening. See [component versions](architecture.md#component-versions).

## Runtime capabilities

| Capability                   | Bridge-owned RPC                     | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings          |
| ---------------------------- | ------------------------------------ | ----------------------------------------------------- | --------------------------------------- |
| Read context                 | Session + runtime                    | Session + runtime                                     | Session projection; runtime unavailable |
| Live text/thinking           | Cumulative extension events          | Cumulative extension events                           | When supplied by the host               |
| Send text/images             | Native ACK                           | Confirmed dispatch; admission unobservable            | Native RPC ACK or SDK dispatch evidence |
| `idle_only` send             | Native admission check               | Native admission gate                                 | SDK gate; unsupported by RPC binding    |
| Standalone `update_session`  | Native setters + rename; busy OK     | Public setters + rename; busy OK                      | Native setters; busy supported          |
| Prompt + model/thinking      | Proven-idle only                     | Supported via `set_model` then `send`                 | Supported via `set_model` then `send`   |
| Native command (`!`/`!!`)    | Yes (`exclude_from_context`)         | Unsupported                                           | Yes                                     |
| Remote `stop`                | Agent, bash, and queued withdrawal   | Agent/bash + queue withdrawal (or `ctx.abort`)        | Yes                                     |
| `maintain_session` (compact) | Idle by default; explicit interrupt  | Idle with admission gate; explicit interrupt          | SDK idle gate; RPC explicit interrupt   |
| `maintain_session` (reload)  | Idle refresh through owned lifecycle | Native resource reload when idle                      | SDK native reload; RPC host callback    |
| TUI handoff                  | Drain, normal EOF, reserved join     | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                 |
| Completion events            | Native settlement                    | Native settlement with the owner profile              | Unsupported                             |

Check `list_sessions` (`status.capabilities`) for the current writer. A custom host may
declare `supportsIdleOnly:true` when its submit callback fences new input
and observes asynchronous preparation. The supplied RPC binding returns
`HOST_ADMISSION_UNSUPPORTED` because a state sample cannot enforce idle admission.

## Remote reload

Owned RPC reload seals and exits the old worker before starting a fresh one.
A companion retains its claim until the replacement generation confirms native
completion. The SDK binding calls `AgentSession.reload()` under its admission
gate. An RPC or custom host supplies this callback:

```text
reload({sessionFile, sessionId, beforeDispatch}) -> Promise<{reloaded:true}>
```

Check idle and close local admission, then invoke `beforeDispatch()` immediately
before reload. Resolve after native completion on the same writer and session.
The controller stays loaded and reports its own component version.

## Model settings and compaction

See [model controls](model-control.md) for public behavior.

### Host model setter

A custom `setModel({model?, thinking_level?, sessionFile, sessionId, beforeDispatch})`
callback checks admission at dispatch, uses Pi's native setters, then verifies
identity and returns the actual `{model:{provider,id}, thinking_level}`.
For model-only changes, carry the prior effort through Pi's native fallback.

### Host compact callback

A custom host can expose `compact({instructions?,interrupt?,sessionFile,sessionId,beforeDispatch})`.
Establish idle through local admission when interrupt is false. Invoke
`beforeDispatch()` immediately before native dispatch and return the native
result after completion. The controller fences overlapping input/compaction and
drains admitted work before release.

## Image-capable owners

The companion and supplied bindings support native image blocks. A custom host
declares `supportsImages:true` and forwards `submit().images`. See
[image input](api.md#image-input-send-and-create).

## Daily TUI and ordinary RPC registration

Use the service's Bridge installation and an [owner profile](configuration.md)
that includes the native session path and grants the intended operations.

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

The companion loads `pi-mcp-bridge/owner.json` under `$XDG_CONFIG_HOME` (default
`$HOME/.config`). A missing default leaves it inactive. Set `PI_MCP_OWNER_CONFIG`
to require a specific private owner file. Only sessions under the configured
`sessionRoots` register. A new session reserves its path before Pi first writes
the file and makes it discoverable.

An ordinary RPC host can load the same companion while retaining its pipes and
lifecycle. To enable it for one launch:

```sh
PI_MCP_OWNER_CONFIG=/absolute/path/owner.json \
pi -e /absolute/pi-mcp-bridge/src/attach-extension.mjs
```

If also set, `PI_MCP_ATTACH_DIR` must agree with the owner file. Directory-only
`PI_MCP_ATTACH_DIR` is the low-level path for hosts managing their own scope;
use an owner profile for scoped daily access and [completion events](events.md).

Apply a new extension setting to a running TUI with `/reload`, or reopen through
its host. Registration follows native file open. To open a session another
writer owns, use handoff or shared control. [Session status](api.md#list-sessions-list_sessions) shows
`saved` when Bridge finds no cooperating live owner.

## Host registration lifecycle

1. Call `reserveHostSession` before opening the canonical `session:{file,header}`
   in the shared `attachmentDir`. Pass the selected Pi SDK's
   `buildSessionProjection` for current and historical leaves. Supply
   `processIdentity(writerPid)` for a separate RPC child, which can start
   without a session before reservation.
2. Open the reserved session through the host's native API. Install
   `createSdkHostBinding(AgentSession)` before local input or use
   `createRpcHostBinding(RpcClient)` with the current native client.
3. Publish via `controller.ready(binding)` after native state identifies the
   reserved session. The controller verifies the snapshot on read and fork.
   Reserve a different session before opening it.
4. For remote release, provide the [session-local close contract](#explicit-deletion).
   `controller.close()` retires the endpoint while a live writer still holds its claim.

A custom `bash` callback returns native output. A `stop` callback returns
`{status:"accepted",acknowledgement,coverage:"agent_and_bash"}`. The inline
`onResult` and `onWithdraw` callbacks retain captured output if the final ACK is
lost. Command support requires bash plus cancel or stop. Remote stop requires
the complete stop callback.

See the [SDK and RPC integration examples](../test/host-integration.test.mjs).

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
extension loading and ownership negotiation. Bridge uses the selected Pi's
argument parser to reject session selectors and mode changes. Option values
such as `--system-prompt --continue` keep their native meaning.
`piArgs --session-dir DIR` sets the fresh session's storage directory. An
already-running companion TUI can invoke `/bridge-join` manually.

### Handoff behavior

1. Fence Bridge input and drain admitted Stop work, ACKs and native preparation.
2. Seal the owned child and confirm its exact exit after normal EOF.
3. Reserve the target for the requester. Under the registry mutex the requester
   moves `reserved` to `opening`, then rechecks the reservation in Pi's pre-open
   hook. Native registration publishes the writer and retires prior claims.

Ctrl+Alt+J cancels. Cancellation before seal dispatch restores admission.
Cancellation after dispatch follows the [shutdown contract](#shutdown-and-in-flight-acks).
A native veto before open removes the reservation. An uncertain switch keeps
the reservation until confirmed closure or exact requester exit.

### Recover an explicit local pause

Release a Bridge-owned writer before using the file with an unregistered Pi:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json release ps_SESSION_ID
```

Normal release requires an idle writer and waits for its sealed EOF and exit.
Append `--interrupt` to send SIGTERM to the verified child, including during
shutdown. Pi can finish shutdown hooks, so a stalled hook can keep release
pending. A caller timeout leaves the request in progress. Unfinished work in
memory may be lost. Both forms can close a known owned writer whose saved file
was removed, using its captured process identity and claim.

Release pauses cold resume until a cooperative join registers a writer or the
owner confirms local closure. A cancelled join preserves the pause. To reset it,
close any local writer using the file and run:

```sh
node src/owner-runtime.mjs /absolute/path/owner.json reset ps_SESSION_ID --confirm-local-closed
```

Reset refuses a live registered owner. The explicit confirmation covers
unregistered writers.

## Shutdown and in-flight ACKs

Service shutdown freezes admission, cancels handoffs and drains dispatched
requests plus received late-ACK checks before closing owned runtimes. It uses
SIGTERM without automatic SIGKILL. External owners retain their claims.

Auto-release, idle local release, handoff and owned reload share the idle-close
path. After reads, ACK checks, native settlement, queues and input preparation
drain, the exact child atomically checks idle and seals new work. Confirmed seal
permits EOF. Shutdown hooks may record cleanup state. Release the claim only
after exact exit. A lost seal reply keeps the fence and permits explicit retry;
post-seal cancellation finishes closure and suppresses the successor.

Native `deliverAs:"nextTurn"` custom messages and in-progress same-file resume
are absent from Pi's current idle evidence. They can lose queued context or
invalidate the seal during replacement. Arbitrary extension background work
also sits outside observed operation lifetimes.

Missing mutation ACKs keep the writer fenced until the matching ACK or exact
exit. Received ACKs must match command, generation and native identity. Late
prompt evidence appears in the [submission receipt](api.md#submission-receipt).

Headless RPC cancels supported dialog methods while stdin is active and reports
`EXTENSION_UI_CANCEL_SENT`. Startup can report `EXTENSION_UI_STARTUP_UNAVAILABLE`
before stdin is ready. After EOF, normal exit can carry `ui.unavailable` for
shutdown dialogs. Errors and notifications appear in [runtime events](reading.md#live-output-and-runtime-extension-events).

## Explicit deletion

Delete cancels pending handoff/release and installs a process-owned exclusion
through writer termination and the recoverable trash move. It can revoke an
unopened reservation. An admitted or uncertain native open must settle or lose
its requester before the move. A startup can be cancelled before launch;
captured process identity permits termination after launch before readiness.

Dedicated writer termination checks the current binding under the registry mutex
before each signal. It sends SIGTERM and escalates after `attachmentExitTimeoutMs`
(default 5 seconds). Exit waits occur outside the mutex. Changed identity or
another session sharing the PID prevents termination. Bridge-created Herdr
scopes also reap remaining worker/tool descendants. A failed move preserves a
cold-resume pause; a completed move clears it even if durability is uncertain.

For a shared host, session-local release closes admission, invokes optional
`cancel()` (or `stop` for active bash), drains preparation and inline output,
then calls `release()` to close the writer and confirm `{released:true}`. A
confirmed same-generation release can authorize deletion after a lost reply.
Failed close keeps admission fenced. Concurrent releases share the attempt and
explicit retry resumes unfinished work. Once the writer confirms closure,
retries only finish registry cleanup. Without a working session-local close,
a shared host returns `DELETE_SHARED_OWNER`.

## Read and fork boundaries

[Reads](reading.md) expose selected, sanitized content. For fork, the live
owner supplies raw `snapshot()` (32 MiB attached limit) or the owned child's
`get_entries`. Bridge pairs that data with the current native header to
preserve branch state and image bytes.
