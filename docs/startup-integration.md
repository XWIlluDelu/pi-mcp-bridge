# Generic Pi startup integration

Bridge targets Pi 1.1.0 public APIs. It can own an RPC child or attach to an
ordinary Pi process loaded with the companion.

## Choose a runtime path

| Path | Startup and ownership | Remote capabilities |
| --- | --- | --- |
| Bridge-owned RPC | An authorized send cold-resumes a saved session using native Pi configuration. Bridge owns the child and its stdin/stdout. | Read, send, status, stop, bash and confirmed-exit deletion, subject to grants. |
| Ordinary Pi TUI/RPC companion | The owner loads the extension at startup. It registers the existing process with Bridge. | Read, send and status. RPC live release/delete and full stop/bash are unsupported. |
| Existing SDK/RPC host | The host reserves before opening a writer, then publishes public API bindings. | Callback-dependent; see [host integration](host-adapter.md). |

There is one registered controller per writer. If a normal profile loads the
companion inside a process already registered for the same native file/session
by Bridge RPC or a host adapter, the companion leaves that claim and its
lifecycle with the existing controller. Ordinary Pi still registers normally.
A live owner with a missing endpoint blocks fallback cold resume.

## Native configuration and installation

The launcher inherits the owner's environment and native settings, tools,
authentication and resource discovery. Explicit `piRuntime.agentDir`,
`inheritEnv`, `tools` and `piArgs` override their respective settings.
Filtering environment variables alone does not isolate file-based credentials;
offline tests use disposable profiles.

For an ordinary Pi process, use the same private IPC directory as Bridge:
the configured `attachmentDir`, or `stateDir/ipc`.

```sh
PI_MCP_ATTACH_DIR=/path/to/private/ipc \
  pi --session /path/to/session.jsonl -e /path/to/src/attach-extension.mjs
# Add --mode rpc for an ordinary RPC process managed by its existing owner.
```

Only open a session with no existing writer. Pi opens an initial `--session`
file before loading extensions. For a Bridge-owned target, use
[owner-local handoff](runtime-handoff.md): `/bridge-join` starts from a fresh or
different local session, or release explicitly before launching the target.

Configuration and extension updates take effect at normal startup/reload.
Updating the Bridge service alone does not replace code loaded in an external
owner. `OWNER_READ_REFRESH_REQUIRED` means that owner's read implementation
cannot satisfy the requested selector; ordinary reads may remain usable.

## Admission and settlement

Native RPC prompt ACKs report `started`, `queued` or `handled`. Because the
companion's public `sendUserMessage` returns void, its receipt reports
`unknown / submitted`. Observe subsequent session activity separately through
status/context reads.

`read(view:"status")` observes runtime state without loading transcript bodies.
Settlement records `{generation, sequence, observed_at, aborted}`, with replacement
generations resetting sequence to zero. Settlement reflects session-wide turn
completion rather than individual request attribution, and does not clear pending
prompt ACKs.

`after_settlement` and `wait_ms` (0–10000) poll for a new observation.
Nonzero wait requires a baseline; an initial observation always runs. The deadline bounds polling, while an
in-flight state/ownership observation retains its normal bounded I/O timeout.
Results distinguish settlement, timeout, generation change and unavailable
observation; permission revocation, cancellation and runtime errors remain visible.

## External process lifecycle

An RPC extension's `ctx.shutdown()` sets a flag checked by a later command or
settlement; it does not confirm process exit. The companion therefore rejects
RPC live deletion and direct socket shutdown with `HOST_RELEASE_UNSUPPORTED`.
Bridge disconnect leaves the external owner running. In RPC mode, registration
or storage failure retires access without requesting host shutdown. TUI release
uses native graceful exit and waits for the owner to exit.

Companion full stop/bash support is limited by public APIs, as described in
[stop](stop.md) and [bash](bash.md). Existing SDK/RPC hosts can supply those
operations through the generic bindings.

## Verification

```sh
node --test test/native-startup.test.mjs test/rpc-companion.test.mjs \
  test/host-integration.test.mjs test/host-lifecycle.test.mjs
```

These offline fixtures exercise production code: native profile/tools and saved
selection, installed companion/controller coexistence, startup/switch ordering,
ordinary RPC plus MCP read/send/status, callback-based SDK/RPC hosts, generation
replacement, permissions and owner retirement. They use synthetic sessions and
providers. General batching behavior is documented in the [tool reference](../README.md#batch-and-receipts).
