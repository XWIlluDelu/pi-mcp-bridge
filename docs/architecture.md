# Architecture and verification

## Development policy

Support only the current Bridge and matching companion/host components; update
them together. Native history projection and raw fork snapshots remain current
functionality. [Development instructions](../AGENTS.md) define cleanup policy,
safety constraints and the separate authorization required for production operations.

## Components

- **Protocol:** `protocol.mjs` owns the public tool registry and MCP dispatcher. `server.mjs` supplies the MCP SDK adapter; `protocol-stdio.mjs` performs bounded LF framing. `http-server.mjs` owns loopback, token, Host and origin checks and bounded HTTP waits. `stdio-proxy.mjs` forwards to one service; it does not run Pi or retry mutations.
- **Policy and admission:** `protocol.mjs` starts a request's policy read before executor waits; `bridge.mjs` captures immutable permission snapshots and composes per-operation checks, session locks and stop/handoff fences. Explicit internal request contexts carry the same snapshot through batch lanes and asynchronous work; direct Bridge/batch calls capture one at entry. `permissions.mjs` resolves independent rights; `owner-config.mjs` validates and atomically edits them. Public schemas live in `tool-schemas.mjs`.
- **History:** `data.mjs` validates native files and identity without requiring the project cwd to be available. `context-read.mjs` projects the effective native branch, applies selectors, then budgets chronological result pages. Known-ID lookups cache file locations but revalidate native identity and cwd on every access. `session-metadata.mjs` caches at most 256 short titles, keyed by inode, size and modification/change times; it never retains transcript bodies.
- **Runtime:** `rpc.mjs` owns child lifecycle, prompt admission, native ACK recovery and the pool. `attachments.mjs` coordinates exact process identity and private IPC. `attach-extension.mjs` is a cooperative native extension; `host-adapter.mjs` supports hosts with an explicit controller contract.
- **Native controls:** `models.mjs` allowlists runtime metadata and validates model/thinking prompt settings. `compact.mjs` keeps read-protected summaries out of control results.
- **Durability:** `create-session.mjs` publishes a complete native prefix before starting the child; `trash.mjs` performs recoverable moves. Command/stop return bounded native output inline. Optional host `onResult`/`onWithdraw` callbacks deliver known partial output on the original connection, never through files or later queries. Bridge drains pending mutations and received late-ACK identity checks, not durable business receipts or replay fingerprints.
- **Local owner control:** `owner-runtime.mjs`, `idle-handoff.mjs`, `join-extension.mjs` and `open.mjs` negotiate before a live session is opened. Owner control is private local IPC, not a remotely authorized prompt command.
- **Observation:** `live-message.mjs` retains bounded native partial text/thinking. The companion reports native idle/pending evidence; owned RPC settlement separately fences idle controls and handoff. `diagnostics.mjs` emits opt-in, privacy-filtered operational events.

MCP, Bridge and attached owners use the same context-timeline read contract and send modes. Forking uses a separate native snapshot that preserves entries omitted by the public projection. An incompatible read contract returns `OWNER_READ_REFRESH_REQUIRED`: update the companion/host with the Bridge; no older Bridge wire is decoded.

## API distinctions

- `list({session_id})` observes task state, current model identity and thinking level from a live owner; absent/unavailable runtime metadata is null. Its `creatable_projects` is limited to configured create-permitted projects represented on the final returned page.
- `send/create` can apply model and/or thinking settings immediately before submitting a prompt on a proven-idle Bridge-owned RPC. Queued messages have no per-message settings binding.
- `stop` cancels execution and withdraws queued text. `compact` changes context. Their permissions, side effects and returned results remain distinct.

## Invariants

1. **One writer.** A known live or uncertain cooperating writer blocks a second writer. Lost IPC is not proof of process death. PID reuse is checked against boot and process-start identity, not an age timeout.
2. **Snapshot authorization.** Capture policy at the authoritative business-request receive boundary, before queues. Authorize before transcript inspection or control, using that immutable policy through execution and returned read/command/stop content. Later edits affect new calls, including repeated mutations and read cursor pages, not an in-flight request. One batch and each fork's combined permissions share one snapshot. Listing metadata has its own grant; references to hidden parents do not bypass it. Identity and Stop/handoff/lifecycle checks remain live.
3. **Report uncertainty.** Preserve uncertainty about native dispatch and results. A missing response is never proof of refusal, and unknown work is never replayed automatically.
4. **Drain received ACKs.** Drain received late-ACK identity checks and capture tasks before final runtime close. Do not wait indefinitely for ACKs that have not arrived.
5. **Native order is authoritative.** Native projection order and source provenance determine timeline ownership; timestamps and extractive excerpts are not substitutes for the native tree.
6. **Stable cursors.** Historical cursors pin leaf, selection and projection identity. Fresh live previews are separate and cannot silently change a historical continuation.
7. **Wire budget.** Budget both the structured selection and the actual escaped/duplicated wire envelope. Batch resizing uses captured observations, not a later reread.
8. **Release ordering.** Host release closes admission, cancels work when needed, drains admitted operations and captures, then closes the writer. A pending native bash must not deadlock waiting for a release callback that is itself behind the drain.

## Verification

`npm test` runs Node's semantic suites against temporary native stores, synthetic providers and explicit agent/environment isolation; no credentials or paid endpoint are needed. Network-disabled native fixtures verify Pi admission, queues, persisted history, shell/stop, TUI menus, ordinary extensions and native entry independently of model quality. Coverage:

- **Authorization:** three-tier rights, unknown-key refusal, receive-time snapshots before delayed executors, concurrent policy isolation, stable authorization through cold startup/locks/disk reads, batch/fork policy consistency, new-call/read-continuation authorization, hidden-parent references and Stop fencing during policy I/O.
- **Reading:** context grouping, hidden/orphan prompt boundaries, system sections, compaction/branch summaries, checkpoint edits, tool pairing, readable Unicode units, frozen bounded history, cursor-only selection inheritance, bounded live observation, warm lookup without rescans, title-cache invalidation, companion idle evidence.
- **Requests and recovery:** independent repeated submissions, ACK timeouts, late identity validation, persistence failures, shutdown drain without replay, shutdown races.
- **Native controls:** image bytes (including more than 32 images within byte limits), model metadata redaction across list/owner IPC, provider-call boundaries, partial selection, default-idle compaction, cancellation and exact-identity idle controls.
- **Batch:** per-session lanes, independent progress, invalid-item isolation, captured-read rebudgeting, envelope byte limits.
- **Ownership:** Unix owner claims, kernel-released registry mutex and exact long-lived owner claims, filesystem aliases, unreachable hosts, release cancellation/drain, idle EOF handoff, cold resume only after an appropriate exact-death condition.
- **Transports:** per-request MCP and current SDK clients over stdio/HTTP, shared proxies, authentication/header errors, frame limits, disconnects, bounded response waits.

CI runs this suite and formatting on Node 22 and 26 for pushes and pull requests to `main`, without provider credentials. `npm run format:check` covers maintained source, tests, docs and the CI workflow. Exact dependency versions and the lockfile pin the SDK and test baseline, not the user's runtime executable. `npm audit` checks the dependency graph and does not replace behavioral protocol or concurrency tests.

## Operational boundaries

- **Registry scope:** one machine, with a shared canonical IPC directory and compatible Linux PID/network namespaces. Unregistered RPC pipes cannot be discovered or taken over.
- **HTTP auth:** the loopback backend authenticates with an owner-local token and is not an OAuth authorization server; a remote tunnel supplies the public authentication boundary.
- **TUI death:** a dying TUI's in-flight model computation is not preserved.

See [runtime](runtime.md) for cooperative entry and restart paths, and [transports](transports.md) for client behavior after unknown outcomes.
