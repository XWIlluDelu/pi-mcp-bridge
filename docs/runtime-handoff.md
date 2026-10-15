# Owner-local runtime handoff and reopen

Remote [stop](stop.md) cancels execution and withdraws queued text while keeping
the process and ownership. Owner-local handoff instead closes a Bridge-owned
writer so ordinary Pi can open the same session file.

| Operation | Effect |
| --- | --- |
| `/bridge-join` | Wait for admitted work, close the Bridge child through native EOF, then switch an idle TUI to that session. |
| `release` | Legacy observed-idle checks followed by timed process teardown. It can interrupt work those checks miss. |
| `reset` | Clear the persistent cold-resume restriction after the local writer has closed. Does not start Pi. |

These operations use the existing private IPC directory and owner registry,
preserving the native session file and ID while transferring writer ownership
sequentially between processes. Continuous bidirectional hot attachment remains
an open design question.

## Join from ordinary Pi

Start normal Pi on a fresh or **different** session, with the companion and the
existing owner's configuration:

```sh
PI_MCP_OWNER_CONFIG=/path/to/owner.json \
PI_MCP_ATTACH_DIR=/path/to/private/ipc \
  pi -e /path/to/src/attach-extension.mjs
```

If already configured in your normal Pi setup, plain `pi` is sufficient.
From the idle local TUI, request the public Bridge session ID once:

```text
/bridge-join ps_EXAMPLE
```

### Wait, close, switch

1. Bridge fences new sends, bash, deletes and stops for the target with
   `HANDOFF_PENDING`. Previously admitted queued messages run naturally.
   An admitted stop finishes its own queue recovery first.
2. Bridge waits for outstanding mutation ACKs, the observed run's
   `agent_settled`, idle/noncompacting state and an empty native queue.
   An observed `agent_start` requires a later settlement; handoff proceeds
   only after mutation ACKs are resolved and queues are clear.
3. Bridge persists `noColdReacquire`, closes its child's stdin and waits for
   native `session_shutdown` and the exact child's zero-code, unsignalled exit.
   This path has no SIGTERM/SIGKILL escalation.
4. Bridge reserves the target for the requesting TUI process. The companion
   checks the reservation in `session_before_switch`, then calls public
   `switchSession`. Pi opens the latest history; `session_start` publishes the
   TUI's ready claim.

A saved session with no active writer can be joined directly. The reservation
blocks other cooperative owners between the old child's exit and the TUI's
registration. After the TUI later exits, `noColdReacquire` remains until
[explicit reset](#explicit-return-to-cold-resume).

### Cancellation and failure

Use **Ctrl+Alt+J** to cancel a waiting join. Pi serializes slash submissions, so
cancellation uses a TUI shortcut rather than another queued slash command.
Disconnect or local session shutdown also cancels the wait.

- **Before EOF:** the RPC remains running and the admission fence is removed.
- **After EOF:** shutdown must finish, but a cancelled join does not open the
  target. A no-cold marker already persisted during the race remains.
- **Native before-switch veto:** only the matching unused reservation is
  cancelled; an explicit new join can retry.
- **Native switch throws:** the open/replacement outcome is uncertain. Keep the
  reservation until that local Pi exits; close it before retrying.

An unresolved ACK, never-settling run or hung shutdown hook keeps waiting until
cancellation where possible; it does not authorize forced exit. Transport,
identity and abnormal-exit errors fail the join. The local TUI must remain idle
and available for switching while it waits.

### Supported boundary

This route controls a Bridge-owned Pi 1.1.0 RPC child's admissions and stdin.
External owners are not closed by join. Independent extension preflight/background
tasks and unregistered writers require coordination outside this barrier. A seen non-RPC input
keeps automatic handoff unconfirmed for that child's lifetime, including reload.

Initial `pi --session target` opens the file before extensions load; do not use
it while another writer owns the target. For an already-running Pi,
`session_before_switch` runs before the target opens and can await or veto it.
This ordering is defined in Pi's
[public runtime implementation](https://github.com/earendil-works/pi/blob/abe508e1b89912adde45528136c3221eb69acdd7/packages/coding-agent/src/core/agent-session-runtime.ts#L196).
The join command uses that pre-open route. Remote companion send rejects
`/bridge-join`, including collision suffixes: it is owner-local control, not
an MCP operation.

## Legacy explicit release

Run against the running Bridge on its owner's machine:

```sh
node src/owner-runtime.mjs /path/to/owner.json release ps_EXAMPLE
# Only after a successful release:
PI_MCP_ATTACH_DIR=/path/to/private/ipc \
  pi --session /path/to/session.jsonl -e /path/to/src/attach-extension.mjs
# Add --mode rpc for an RPC process with its owner's stdin/stdout routing.
```

Release/reset target sessions discoverable in owner-configured roots. They use
the owner-only Unix control socket, not a remote MCP read grant. The IPC directory
is `attachmentDir`, otherwise `stateDir/ipc`.

Release checks native identity, observed streaming/compaction/queue state,
unacknowledged prompt admission and the owned-child preflight observer. Busy or
unknown state, startup/admission uncertainty, transport errors and external
owners are rejected. It persists `noColdReacquire` before stopping; success means
the exact owned child has exited. Stop failure leaves the restriction in place.
Saved sessions with no active runtime can also be marked released.

Observed overlapping inputs keep the legacy observer unconfirmed until process
exit, including across reload.
Conversely, one held `before_agent_start` input can be masked by settlement from
a separate `pi.sendMessage(...,{triggerTurn:true})` turn, which bypasses the
input event. Release can interrupt that held preparation.
Handled inputs that never settle can also keep release blocked.

Legacy release, service shutdown and deletion invoke `PiRpc.stop()`:
SIGTERM, followed by SIGKILL after 1.5 seconds if needed, which can cut longer
shutdown hooks short. This is process teardown, not remote `stop`. Use EOF-based
join for controlled RPC-to-TUI transfers; otherwise arrange normal owner closure.

## Explicit return to cold resume

The no-cold marker has no TTL. It survives Bridge restart, owner registration,
reload and exit, while allowing valid attached read/send and saved-history reads.

Close the local Pi first, then confirm all local writers for this session have
stopped:

```sh
node src/owner-runtime.mjs /path/to/owner.json reset ps_EXAMPLE --confirm-local-closed
```

Reset refuses a still-live cooperative owner. The confirmation is the owner's
assertion about unregistered writers; reset cannot discover all arbitrary Pi
processes. It clears only the restriction. The next authorized send can
cold-resume using normal Pi configuration. Restarting Bridge is not a reset.

### Interrupted registry updates

Registry transactions publish a complete process identity atomically. After that
exact process exits, a later transaction can reclaim its lock without weakening
the separate writer claim or clearing `noColdReacquire`. Concurrent recovery is
serialized by a short-lived Linux abstract socket; the kernel releases it if the
recovering process dies. The opened inode stays pinned until the pathname check,
so recovery cannot delete a new holder's replacement lock.

Registry participants use the same canonical IPC directory and Linux PID/network
namespaces. Live locks and old locks with unreadable or incomplete identities
remain blocked; age alone never authorizes removal. After a TUI crash, use the
normal confirmed reset command rather than manually unlinking registry files.

## Verification

| Test | Main coverage |
| --- | --- |
| `idle-handoff.test.mjs` | RPC-to-TUI join, admitted work/queues, EOF shutdown, cancellation, reservation/veto and control-operation races. |
| `native-startup.test.mjs` | Native configuration, installed companion/controller coexistence and initial versus before-switch file-open order. |
| `owner-runtime.test.mjs` | Release/reset CLI, exact exit, persistent restriction, observer/reload limits and errors. |
| `host-lifecycle.test.mjs`, `attachments.test.mjs` | Owner retirement, released tombstones, TUI reopen and replacement generations. |
| `registry-lock.test.mjs` | Current/legacy writer crashes, concurrent recovery, directory aliases, replacement-inode protection and complete lock publication. |
