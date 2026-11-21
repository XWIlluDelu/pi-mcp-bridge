# Architecture and verification

## System shape

```text
MCP clients ──stdio──► server.mjs ────────┐  MCP 2026-07-28 (per-request)
(Dots/Claude/Grok) ─► http-server.mjs ────┼──► protocol.mjs / batch.mjs
stdio-only ──► stdio-proxy.mjs ──HTTP─────┘  & 2025-11-25..2024-11-05 (initialize)
                                                          │
                                                          ▼
                                                Bridge (bridge.mjs)
                                     bridge-read · bridge-mutations · bridge-local
                                     permissions · read-cache · submissions · events
                                                          │
                      ┌───────────────────────────────────┼───────────────────────────────┐
                      │                                   │                               │
                      ▼                                   ▼                               ▼
           Bridge-owned Pi RPC                  Companion extension                Optional integrations
         (rpc.mjs + rpc-observer.mjs)      (attach-extension.mjs / companion.mjs)   (integrations/*)
                      └────── single-writer registry (attachments.mjs) ──────┘
                                               Native Pi JSONL files
```

Bridge never writes to a session file alongside another live Pi process. Each session has at most one live writer (a Bridge-owned Pi RPC child, a user's TUI/RPC companion, or an embedded SDK/RPC host), coordinated through the shared owner registry. Reads never start Pi.

## Module map

Runnable entry points and Pi extensions stay at top-level `src/` paths (so systemd units, MCP client configs and Pi settings never break). Internal modules are grouped by domain under `src/`, and optional Pi extension adapters live under `integrations/`:

| Directory / Entry                   | Modules                                                                                                                                                                                                                                                                                                                                         | Responsibility                                                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`src/` (entry points)**           | `server.mjs`, `http-server.mjs`, `stdio-proxy.mjs`, `attach-extension.mjs`, `owner-permissions-extension.mjs`, `open.mjs`, `owner-runtime.mjs`                                                                                                                                                                                                  | Direct stdio MCP server, shared HTTP MCP server, stdio-to-HTTP proxy, Pi TUI/RPC companion, TUI permission menu, terminal handoff launcher, owner-local release/reset CLI                       |
| **`src/mcp/`**                      | `protocol.mjs`, `protocol-stdio.mjs`, `http-config.mjs`, `tool-schemas.mjs`, `schema.mjs`, `batch.mjs`, `response-budget.mjs`                                                                                                                                                                                                                   | Dual MCP dispatch (`2026-07-28` per-request + `2025-11-25`..`2024-11-05` initialize), 13 layered Zod tool schemas, batch lane ordering, exact UTF-8 & duplicated wire budgeting                 |
| **`src/core/`**                     | `bridge.mjs`, `bridge-read.mjs`, `bridge-mutations.mjs`, `bridge-local.mjs`, `permissions.mjs`, `owner-config.mjs`, `storage.mjs`, `data.mjs`, `submissions.mjs`, `errors.mjs`, `diagnostics.mjs`, `kernel-lock.mjs`, `lf-lines.mjs`                                                                                                            | Request policy snapshots, session lanes & automatic release, read/mutation/local handoff, 7-right permission resolution, JSONL discovery & storage, late-ACK receipts, error codes, diagnostics |
| **`src/read/`**                     | `context-read.mjs`, `read-render.mjs`, `read-navigation.mjs`, `read-cache.mjs`, `read-snapshots.mjs`, `read-schema.mjs`, `read-adapters.mjs`, `read-features.mjs`, `context-observation.mjs`, `live-message.mjs`, `runtime-events.mjs`, `session-metadata.mjs`                                                                                  | Native projection selection, sanitization, code-point paging & rendering, preview rows & ref expansion, frozen LRU snapshot cache, runtime request observation, live streaming tail             |
| **`src/compat/` & `integrations/`** | `compatibility.mjs`, `compatibility-services.mjs`, `session-readers.mjs`, `integrations/magic-context/`, `integrations/intercom/`                                                                                                                                                                                                               | External module loader/lifecycle, input-mapping & session-reader service ports, optional extension adapters                                                                                     |
| **`src/ops/`**                      | `create-session.mjs`, `native-create.mjs`, `trash.mjs`, `prompt-input.mjs`, `models.mjs`, `model-catalog.mjs`, `native-model-catalog.mjs`, `set-model.mjs`, `compact.mjs`, `bash-execution.mjs`, `stop-execution.mjs`                                                                                                                           | Session creation/forking, recoverable trash, prompt/image validation, model catalog & selection, compaction, bash & stop helpers                                                                |
| **`src/runtime/`**                  | `rpc.mjs`, `runtime-pool.mjs`, `rpc-observer.mjs`, `rpc-ui.mjs`, `pi-installation.mjs`, `reload-admission.mjs`, `attachments.mjs`, `attachment-protocol.mjs`, `companion.mjs`, `companion-profile.mjs`, `join-extension.mjs`, `host-adapter.mjs`, `host-bindings.mjs`, `herdr-control.mjs`, `herdr-rpc-transport.mjs`, `herdr-worker-entry.mjs` | Owned Pi RPC lifecycle & pool, single-writer claims & companion IPC, `/bridge-join` terminal handoff, optional SDK/RPC host bindings & Herdr placement                                          |
| **`src/events/`**                   | `events.mjs`, `event-webhook.mjs`, `settled-observer.mjs`, `settled-result.mjs`                                                                                                                                                                                                                                                                 | Completion webhooks (`session.settled`) and native settlement observation                                                                                                                       |

## Component versions

`package.json` defines the product version. The control envelope binds requests
and replies to the generation, canonical file and native session ID. Bridge puts
the target's advertised release in the existing wire `version` slot so running
owners recognize the request. Operations depend on the current envelope,
request and reply shapes, and the required owner capability. Live reads use
`READ_CONTRACT` and report `OWNER_READ_REFRESH_REQUIRED` when it differs.
The writer claim remains in force through interface mismatches. See
[AGENTS.md](../AGENTS.md) for the release and ownership rules.

## Invariants

1. **One writer.** A live or uncertain owner blocks another writer. A claim ends
   after exact process exit, completed native replacement or confirmed
   session-local writer closure by its host.
2. **Request authorization.** One receive-time policy snapshot governs an
   operation, including batch items and fork checks. Identity, Stop and lifecycle
   fences remain live throughout execution.
3. **Native outcomes.** External dispatch evidence does not imply native admission.
   Missing ACKs leave outcomes unknown; bounded `submissions.mjs` receipts retain
   matching late ACKs without replay. Shutdown drains received ACK checks and captures.
4. **Ordered release.** Close admission, cancel when authorized and drain admitted
   work and captures. Non-interrupting owned RPC shutdown requires the child to
   synchronously check idle and seal new business work before EOF; exact exit
   precedes claim release. An unknown seal acknowledgement retains ownership and
   admission fences. See the [shutdown contract](runtime.md#shutdown-and-in-flight-acks).
5. **Native provenance.** Projection order determines prompt ownership and tool
   pairing. Fork uses raw native records rather than the public read projection.
6. **Frozen, bounded reads.** Cursors retain selected history and identity while
   each page rechecks authorization. Budgets include structured results and the
   duplicated wire envelope; batch never rereads after a later mutation.

## Verification

Run `npm test` and `npm run format:check`. Tests use temporary native stores,
isolated agent environments and synthetic providers without credentials or paid
endpoints. CI runs both commands on Node 22 and 26 for pushes and pull requests
targeting `main`. Local development uses the same checks. Native PTY checks
require `script`, and the test environment must permit Unix sockets and preserve
POSIX file ownership needed by storage-integrity checks (Linux).

Module tests live beside their implementations under `integrations/`.

Pi is an external test dependency. Tests use PATH or an explicit installation:

```sh
BRIDGE_TEST_PI_CLI=/absolute/path/to/pi npm test
```

The optional real Herdr check requires Linux with a working user-systemd bus:

```sh
BRIDGE_TEST_HERDR=/absolute/path/to/herdr node --test test/herdr-runtime.test.mjs
```

It creates and removes an isolated named daemon. Normal test runs skip this
opt-in check. `npm audit` checks dependency advisories separately.

## Operational boundaries

The cooperative registry requires one machine and a shared canonical IPC
directory and shared Linux PID and network namespaces. Unregistered writers need host
coordination before reopening; see [runtime](runtime.md). The HTTP backend uses
an owner-local token, with public authentication supplied by a tunnel; see
[transports](transports.md).
