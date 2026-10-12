# Owner-local runtime release and reopen

Release closes a Bridge-owned writer so ordinary Pi can open the same native
session file. Reset permits later cold resume. Both use owner-local IPC and
preserve the native ID, settings and grants.

## Release, then open

Use the running Bridge's owner configuration and public session ID:

```sh
node src/owner-runtime.mjs /path/to/owner.json release ps_EXAMPLE
# After release reports success:
PI_MCP_ATTACH_DIR=/path/to/private/ipc \
  pi --session /path/to/session.jsonl -e /path/to/src/attach-extension.mjs
# Add --mode rpc for an RPC process managed by its existing owner.
```

The CLI uses the owner-only socket in `attachmentDir`, otherwise `stateDir/ipc`.
The session must be discoverable in configured roots. These controls do not
require a remote read grant or change the caller's MCP permissions.

Release checks native identity, observed streaming/compaction/queue state,
unacknowledged prompt admission and the owned-child preflight observer. Busy,
unknown or uncertain state and external owners are rejected. It persists
`noColdReacquire` before teardown and reports success only after the exact owned
child exits. Failure leaves the restriction in place. Saved sessions without an
active runtime can also be marked released.

The restriction survives Bridge restart, owner registration, reload and exit,
with no TTL. Valid attached read/send and saved-history reads remain available.

## Reset after the local writer closes

```sh
node src/owner-runtime.mjs /path/to/owner.json reset ps_EXAMPLE --confirm-local-closed
```

Reset refuses a still-live cooperative owner. The confirmation covers unregistered
writers that Bridge cannot discover. It clears only the restriction; the next
authorized send can cold-resume. Restarting Bridge is not reset.

## Startup and observation boundaries

Pi opens and may migrate an initial `--session` file before loading extensions.
Release must precede that launch. An already-running Pi has an awaited
`session_before_switch` hook before target open, but this release path does not
implement automatic takeover or a before-switch controller.

The observer retains a seen input until settlement. Observed overlapping inputs
keep release unconfirmed until process exit, including across extension reload.
Handled inputs that never settle can also keep release blocked. The prompt ACK
fence separately protects unacknowledged RPC admission.

A settlement can belong to a separate `pi.sendMessage(...,{triggerTurn:true})`
turn that bypasses the input event. Such a turn can clear the observer while one
`before_agent_start` input is still preparing, allowing release to interrupt it.
Independent extension background work is also outside these observations.

Release, service shutdown and deletion use `PiRpc.stop()`: SIGTERM followed by
SIGKILL after 1.5 seconds if needed. A longer native shutdown hook can be cut
short. Native stdin EOF can await shutdown, but this release command does not
use that path. Arrange normal closure when these observations are insufficient.

## Verification

`native-startup.test.mjs` covers profile discovery and initial/before-switch
file-open order. `owner-runtime.test.mjs` covers release/reset, exact exit,
persistent restrictions, ACK/observer limits and errors. Attachment and host
lifecycle tests cover reopen, replacement generations and released owners.
