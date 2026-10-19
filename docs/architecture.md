# Architecture and verification

## Components

- **Protocol:** `protocol.mjs` owns the public tool registry and MCP dispatcher. `server.mjs` supplies the MCP SDK adapter; `protocol-stdio.mjs` performs bounded LF framing. `http-server.mjs` owns loopback, token, Host and origin checks and bounded HTTP waits. `stdio-proxy.mjs` forwards to one service; it does not run Pi or retry mutations.
- **Policy and admission:** `bridge.mjs` composes per-operation permission checks, request receipts, session locks and stop/handoff fences. `permissions.mjs` resolves independent rights; `owner-config.mjs` validates and atomically edits them. Public schemas live in `tool-schemas.mjs`.
- **History:** `data.mjs` validates native files and identity without requiring the project cwd to be available. `context-read.mjs` projects the effective native branch, applies selectors, then budgets chronological result pages. Known-ID lookups cache file locations but revalidate native identity and cwd on every access. `session-metadata.mjs` caches at most 256 short titles, keyed by inode, size and modification/change times; it never retains transcript bodies.
- **Runtime:** `rpc.mjs` owns child lifecycle, prompt admission, native ACK recovery and the pool. `attachments.mjs` coordinates exact process identity and private IPC. `attach-extension.mjs` is a cooperative native extension; `host-adapter.mjs` supports hosts with an explicit controller contract.
- **Durability:** `journal.mjs` binds each request ID to its operation, target and body, serializes transitions and fsyncs durable receipts. `create-session.mjs` publishes a complete native prefix before starting the child. `trash.mjs` performs recoverable moves. The stop and bash modules capture native results independently of a disconnected MCP response.
- **Local owner control:** `owner-runtime.mjs`, `idle-handoff.mjs`, `join-extension.mjs` and `open.mjs` negotiate before a live session is opened. Owner control is private local IPC, not a remotely authorized prompt command.
- **Observation:** `live-message.mjs` retains bounded native partial text/thinking. `activity.mjs` separates idle evidence from settlement. `diagnostics.mjs` emits opt-in, privacy-filtered operational events.

MCP, Bridge and attached owners use the same context-timeline read contract and send modes. Forking uses a separate native snapshot that preserves entries omitted by the public projection. An incompatible owner returns `OWNER_READ_REFRESH_REQUIRED`.

## Invariants

1. **One writer.** A known live or uncertain cooperating writer blocks a second writer. Lost IPC is not proof of process death. PID reuse is checked against boot and process-start identity, not an age timeout.
2. **Authorize first.** Authorize before body inspection or control, and recheck after material waits and before returning read/command/stop content. Listing metadata has its own grant; references to hidden parents do not bypass it.
3. **Persist uncertainty.** Record uncertainty before a side effect. A missing response or failed outcome write is never proof of refusal, and unknown work is never replayed automatically under a new ID.
4. **Drain received ACKs.** Drain received late-ACK identity, capture and receipt tasks before final runtime close. Do not wait indefinitely for ACKs that have not arrived.
5. **Native order is authoritative.** Native projection order and source provenance determine timeline ownership; timestamps and extractive excerpts are not substitutes for the native tree.
6. **Stable cursors.** Historical cursors pin leaf, selection and projection identity. Fresh live previews are separate and cannot silently change a historical continuation.
7. **Wire budget.** Budget both the structured selection and the actual escaped/duplicated wire envelope. Batch resizing uses captured observations, not a later reread.
8. **Release ordering.** Host release closes admission, cancels work when needed, drains admitted operations and captures, then closes the writer. A pending native bash must not deadlock waiting for a release callback that is itself behind the drain.

## Verification

`npm test` runs Node's semantic suites against temporary native stores, synthetic providers and explicit agent/environment isolation; no credentials or paid endpoint are needed. Network-disabled native fixtures verify Pi admission, queues, persisted history, shell/stop, TUI menus, ordinary extensions and native entry independently of model quality. Coverage:

- **Authorization:** three-tier rights, unknown-key refusal, live edits, continuation/replay authorization, revocation during cold startup, hidden-parent references, current permissions after cached lookup.
- **Reading:** context grouping, hidden/orphan prompt boundaries, system sections, compaction/branch summaries, checkpoint edits, tool pairing, Unicode reconstruction, pinned history, bounded live observation, warm lookup without rescans, title-cache invalidation, companion idle evidence.
- **Requests and recovery:** concurrent deduplication, ACK timeouts, late identity validation, persistence failures, crash/restart receipt recovery, shutdown races.
- **Batch:** per-session lanes, independent progress, invalid-item isolation, captured-read rebudgeting, envelope byte limits.
- **Ownership:** Unix owner claims, namespace-safe dead-owner registry recovery, filesystem aliases, unreachable hosts, release cancellation/drain, idle EOF handoff, cold resume only after an appropriate exact-death condition.
- **Transports:** modern and legacy standard MCP clients over stdio/HTTP, shared proxies, authentication/header errors, frame limits, disconnects, bounded response waits.

CI runs this suite and formatting on Node 22 and 26 for pushes and pull requests to `main`, without provider credentials. `npm run format:check` covers maintained source, tests, docs and the CI workflow. Exact dependency versions and the lockfile pin the tested protocol/native baseline. `npm audit` checks the dependency graph and does not replace behavioral protocol or concurrency tests.

## Operational boundaries

- **Registry scope:** one machine, with a shared canonical IPC directory and compatible Linux PID/network namespaces. Unregistered RPC pipes cannot be discovered or taken over.
- **HTTP auth:** the loopback backend authenticates with an owner-local token and is not an OAuth authorization server; a remote tunnel supplies the public authentication boundary.
- **TUI death:** a dying TUI's in-flight model computation is not preserved.

See [runtime](runtime.md) for cooperative entry and restart paths, and [transports](transports.md) for client recovery using the same `request_id`.
