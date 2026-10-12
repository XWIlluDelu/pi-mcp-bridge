# Generic Pi startup integration

Bridge uses Pi 1.1.0 public APIs through two paths: an owned RPC child, or an
ordinary TUI/RPC process loaded with the companion. Existing SDK/RPC hosts can
instead [reserve and publish their own binding](host-adapter.md).

## Configuration and ownership

The launcher inherits native environment, settings, tools, authentication and
resource discovery. Explicit `piRuntime.agentDir`, `inheritEnv`, `tools` and
`piArgs` override their respective settings. Environment filtering does not
isolate file-based credentials; offline tests use disposable profiles.

Ordinary Pi keeps its existing configuration and input lifecycle. Load the
companion with the same private IPC directory as Bridge:

```sh
PI_MCP_ATTACH_DIR=/path/to/private/ipc \
  pi --session /path/to/session.jsonl -e /path/to/src/attach-extension.mjs
# Add --mode rpc for an ordinary RPC process with its owner's stdin/stdout.
```

Pi opens an initial `--session` file before loading extensions. For Bridge-owned targets, use [owner-local release/reset](runtime-handoff.md)
before opening the file. Release persists a cold-resume restriction until reset;
its idle observations and timed teardown have separate limits.
A live but unreachable registered owner blocks fallback; socket loss does not
release a writer. Generic host reservation must precede native session open.

An external owner caches its loaded adapter/renderer. Updating Bridge does not
reload that owner. `OWNER_READ_REFRESH_REQUIRED` means its loaded code cannot
honor a precise text selector; coordinate writer closure before reopening.

## Admission and settlement

Owned RPC prompt ACKs report `started`, `queued` or `handled`. The companion's
public `sendUserMessage` returns void, so its receipt reports `unknown/submitted`.
Model completion is observed separately.

`read(view:"status")` observes runtime state without loading transcript bodies.
Settlement uses `{generation, sequence, observed_at, aborted}`; a replacement
generation starts at zero. It is session-wide, not exclusive send completion or
proof of current idle, and cannot clear an unresolved prompt ACK.

`after_settlement` and `wait_ms` (0–10000) poll for a later observation. Nonzero
wait requires a baseline; an initial observation always runs. The deadline bounds polling; in-flight state/ownership
I/O retains its own timeout. Results distinguish settlement, timeout, generation
change and unavailable observation. Permissions, cancellation and genuine errors
remain visible. Status also works in ordered batches.

## External lifecycle

An RPC extension's `ctx.shutdown()` sets a flag checked by a later command or
settlement. It does not confirm exit. The companion therefore refuses RPC live
delete/shutdown with `HOST_RELEASE_UNSUPPORTED`; Bridge disconnect leaves that
owner running. Registration/storage failure retires access without requesting
RPC shutdown. TUI release uses graceful native exit and waits for the exact owner.

## Verification

```sh
node --test test/startup-integration.test.mjs test/rpc-companion.test.mjs \
  test/host-integration.test.mjs test/host-lifecycle.test.mjs test/native-startup.test.mjs
```

Offline fixtures exercise native profile discovery, public RPC/SDK behavior,
ordinary companion plus MCP read/send/status, generation replacement, permissions,
receipt replay and unsupported external release. The native RPC bash probe tests
Pi's own command path, not an additional companion capability.
