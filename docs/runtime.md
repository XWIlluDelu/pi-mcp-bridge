# Native runtime, ownership and local entry

The Bridge reuses a cooperating live Pi instance. It starts an RPC child only
when no live registered writer owns the saved session. Ownership includes the
native session ID, canonical file, generation and exact Linux process identity
(PID, process start time and boot ID). A live but unreachable owner blocks
control and cold startup; it never authorizes a fallback writer.

This is a cooperative registry, not a global lock imposed on every Pi process.
An unregistered RPC process has no generic attach-by-PID API. Its original host
must load the companion/controller, or close it before a cooperative reopen.
Multiple MCP clients should share one Bridge service; independent Bridge
processes do not proxy each other's private RPC pipes.

## Runtime capabilities

| Capability                        | Bridge-owned RPC                              | Ordinary TUI/RPC companion                            | Supplied SDK/RPC host bindings            |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------------- | ----------------------------------------- |
| Read context                      | Yes                                           | Yes                                                   | Native snapshot                           |
| Live text/thinking                | Native delta events                           | Public extension events                               | When the host supplies live observation   |
| Send text/images                  | Native ACK                                    | Submission observable; acceptance unknown             | Native RPC ACK or SDK submission evidence |
| Models; standalone model/thinking | Yes                                           | Yes                                                   | Yes                                       |
| Prompt + model                    | Proven-idle only                              | Unsupported                                           | Unsupported                               |
| Native command / stop             | Yes, including queued-input withdrawal        | Unsupported                                           | Yes                                       |
| Manual compact                    | Idle by default; explicit interrupt supported | Unsupported                                           | Unsupported                               |
| Remote reload                     | Proven-idle `rpc_reopen`                      | Unsupported; local TUI `/reload` instead              | Host controls lifecycle                   |
| TUI handoff                       | Drain and normal EOF, then reserved TUI join  | Local `/bridge-join`; cold resume after graceful quit | Host controls lifecycle                   |

Saved sessions can be read without a runtime. Authorized send or command can
cold-start an RPC; stop never does. Model discovery starts an inactive session
only with explicit `start:true`. Custom hosts expose only the callbacks and
capabilities they implement.

The ordinary companion returns `PI_ACCEPTANCE_UNOBSERVABLE` after
`sendUserMessage()`; a successful transport write is not an admission ACK.
It returns `BASH_UNSUPPORTED` / `STOP_UNSUPPORTED`, rather than presenting
agent-only abort as stop-all. A native command must use Pi's bash path, including
`user_bash`, native history and cancellation—not a second shell executor.

Default sending follows ordinary TUI Enter: steer while busy. Explicit
follow-up maps to Pi's follow-up queue. Pi's configured queue consumption modes
remain in effect. Idle-only checks available admission/preparation state and
does not silently convert a busy input into a queued one.

## Model settings, compaction and reload

Runtime model discovery and standalone session model/thinking settings are
available on owned RPC and updated cooperative bindings. Model-plus-prompt
selection, manual compaction and `reload` via `rpc_reopen` require an owned RPC.
See [native controls](model-control.md) for precise queue/model timing, default
idle-only compaction, permission checks, reload's normal EOF lifecycle and
unsupported routes. RPC reopen changes generation but preserves committed
session identity/context; it does not restart the Bridge service.

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
merely because their files were updated: use safe reload/reopen.

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
2. Wait for accepted work, queued inputs, native settlement hooks and confirmed
   quiescence. Missing preparation evidence is a refusal, not an idle guess.
3. Close the old owned RPC stdin and observe that exact child's normal exit,
   including its shutdown hooks. Handoff does not escalate to process signals.
4. Reserve the target for the requesting TUI **before** `switchSession()`.
5. Recheck the reservation in Pi's cancellable pre-open hook and switch to the
   latest saved history.

Owner automation should call the handoff protocol directly. Idle-gated controls
and local release share its ACK, queue and settlement checks; completed queued RPC
input does not leave a lasting preflight barrier. New mutations are fenced during
handoff; reads remain available while it waits.

Pi 1.3 reports `before_agent_start` as busy. Earlier `input` hooks still precede
that busy state, and independent extension-origin input has no completion
correlation ID. An instance that has received such input can remain unconfirmed
even after a settlement event. This does not block ordinary prompts or standalone model
settings. If lossless release cannot be established, use the explicit interrupting
maintenance path below rather than inferring completion from a quiet stream.

While waiting, the fresh TUI does not mirror the old RPC's live output.
Notifications explain waiting/failure; Ctrl+Alt+J cancels. A startup extension
that begins unrelated local work can make the fresh TUI busy; join refuses
that state and can be retried explicitly once the local work finishes.
Cancellation before EOF restores admission; cancellation after EOF lets shutdown finish but does
not open the destination. A thrown, possibly partial native switch retains the
reservation until that process closes. A returned cancellation permits an
explicit retry, not an automatic retry loop.

Closing the native TUI ends its running work; it does not transfer that work to
a daemon. On a real `session_shutdown(reason: "quit")`, the companion retires
its endpoint and marks cold resume as allowed **after exact process death**.
Reload and session replacement never set that marker. This lets a normally
closed joined TUI continue headlessly without a manual reset. An unfinished
reservation, failed teardown or unmarked crash retains the local handoff fence;
the owner-local reset command requires confirmation that the local writer is
closed. A live writer always continues to block startup.

### Recover a retained local fence

Use the running owner Bridge's local control endpoint, not an MCP prompt:

1. Identify and close the original TUI/RPC writer and any unregistered writer
   of that target. An unreachable endpoint does not prove process death.
2. If a cancelled reservation or unmarked crash left `noColdReacquire`, confirm
   local closure explicitly:

   ```sh
   node src/owner-runtime.mjs /absolute/path/owner.json reset ps_SESSION_ID --confirm-local-closed
   ```

3. Retry the safe open launcher, or send a new authorized prompt to continue
   from saved history. Reset does not recover unfinished in-memory work.

Reset checks registered owner identity and refuses a live owner. It cannot
discover every unregistered Pi process; that closure is the local operator's
confirmation. Do not delete owner claims or forge a released record to bypass
a surviving writer. If the Bridge service itself crashed, restart it first;
a stale `bridge.lock` also requires operator confirmation that the original
service is gone, rather than automatic lock stealing.

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

This private local operation verifies the owned child/session identity, sends
SIGTERM and waits for its exit. It does not require idle, send SIGKILL on a timer,
or terminate a shared companion/host. Saved history remains intact; unfinished
in-memory work may be lost. After confirming all local writers have closed, use
the reset command above to permit cold resume of the same saved session.
A client timeout does not cancel an exit already requested or release ownership.
If signal delivery fails, the owner may retry explicitly after resolving the error;
there is no automatic retry.

## Shutdown and durable recovery

Bridge process shutdown also waits for SIGTERM termination without automatic
SIGKILL escalation. A process manager's independent stop timeout still applies;
configure it according to the owner's maintenance policy.

Prompt ACKs establish started/queued/handled admission, not model completion.
A timeout after dispatch means `unknown`. Retry the same business
`request_id` to recover the receipt; do not submit a new ID to guess whether
the operation happened.

Received late ACKs create tracked recovery tasks. Each task includes native
identity verification, durable result/withdrawal capture and any final receipt
transition. Runtime and pool `drainRecovery()` wait for those tasks before
closing the native child; Bridge shutdown drains them before its journals and
runtime pool finish. ACKs not yet received do not create an unlimited shutdown
wait. Failed identity or persistence checks preserve uncertainty instead of
inventing success. Late receipt-persistence failures and filesystem write
failures remain in the runtime/pool's sticky `recoveryFailures` set, even after
that runtime leaves the pool. `pool.recoveryError()` returns an uncertain
`RECOVERY_PERSIST_FAILED` aggregate for shutdown reporting after cleanup;
pre-close draining does not throw these failures or leave the child running.
Identity mismatch alone is not classified as a storage shutdown error.

For cooperative host deletion, reserve ownership before opening the writer and
publish callbacks only after it is ready. Release follows three phases:

- Close admission and retire the endpoint.
- Invoke optional `cancel()` to cancel host-owned work, then drain every admitted
  operation, including asynchronous preparation and durable result capture.
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

Public attached reads run the context selector at the owner and transfer only
the bounded response. They do not impose the raw-snapshot size ceiling on a
small context selection. The host still supplies native entries in memory, and
owned RPC `get_entries` still transfers full entries before projection; these
are remaining full-history costs, not streaming history APIs.

Live output is a separate transient observation, not a historical timeline
entry or final provider payload. Owned RPC reconstructs native text/thinking
deltas; the companion observes cumulative native message events. The retained
observation is capped at 65,536 UTF-16 units and marks upstream truncation.
The read renderer further budgets the preview within `max_bytes`. It appears
only on a fresh unpinned current-leaf read, never on a historical cursor or
explicit-leaf read. Completion hands authority back to native entries. A null
partial message means no unfinished assistant was observed, not that all
agent/tool work is idle. Tool-result streams and independent bash chunks are
not exposed as assistant text.

Fork uses the cooperative `runtime.snapshot()` operation:
`{sessionFile,sessionId,entries,leafId}`. It contains raw native records, not
the public read projection, and leaves the parent writer in place. Attached
snapshots are limited to 32 MiB; oversized or old unsupported owners fail
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
