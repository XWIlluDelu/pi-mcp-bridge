# Dispatch, observation and continued work

Bridge reuses a local Pi session and its environment. The useful cooperation loop
is send → know what was accepted → observe activity → read useful results → send
the next instruction in the same session. Admission, session activity and run
completion are different facts; the API keeps them distinct.

## Evidence and comparison

Reviewed on 2026-10-24 against Pi 1.4.0, Bridge's current implementation and
Codex main commit
[`970111f6`](https://github.com/openai/codex/commit/970111f6cb62cc02fe36a82ea7d71b37a2889c97).

Codex App Server has native Thread / Turn / Item identities. `turn/start` awaits
Core's start-or-steer decision and returns the actual turn identity; a busy
request can join an existing turn. `turn/steer` uses `expectedTurnId`.
`turn/completed` carries that same thread/turn identity, final status and error.
This makes the return useful for the next decision without reading conversation
text to infer whether an input arrived.

Primary sources:

- [App Server turn routing](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs#L661)
  and [Core start-or-steer contract](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/codex_thread.rs#L412).
- [Steering precondition](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L317)
  and [completed notification construction](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/bespoke_event_handling.rs#L1378).
- [Turn and item reads](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1760)
  support turn summaries, item listing by turn and expansion by item IDs.
  [Summary selection](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/turn_items_view.rs#L6)
  uses the first user message and last agent message.

The user's dot MCP experience supplies separate evidence: `send_message` returns
threadId, turnId and admissionOutcome; completion callbacks and latestTurn use
the same identity. Its `read(threadId,limit,cursor)` wrapper currently lacks a
turnId argument and can return empty items with a continuation. Those are wrapper
observations, not App Server limits. The [harness article](https://openai.com/index/unlocking-the-codex-harness/)
explains the shared harness and event model; [Introducing dots](https://openai.com/index/introducing-dots/)
does not specify the private cloud_threads protocol or its delivery guarantees.

An ID also does not establish retry safety. Codex Core explicitly notes that
dropping the reply waiter does not retract an already queued request. Its
clientUserMessageId is used for user-item correlation; the reviewed path does not
establish an idempotent replay contract.
[Submission implementation](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/mod.rs#L1115).

## Changes chosen for Bridge

**Confirm dispatch without inventing admission.** Pi's public extension
`sendUserMessage()` returns void; SDK `prompt()` resolves after input processing
or a full run. Its `preflightResult` option is documented as an internal hook.
The companion previously returned `unknown / PI_ACCEPTANCE_UNOBSERVABLE` after
every call, even when dispatch was confirmed. It now reports `dispatched` with
`admission:"unobservable"` when the public method returns normally. Synchronous
exceptions and transport failures remain uncertain. This removes unnecessary
body reads to confirm dispatch while preserving the actual API boundary.

**Retain the admission evidence already available.** Owned RPC already has a
request UUID, matching native ACK and identity-checked late-ACK path. Send/create
now expose that UUID as `submission_id`; `submission` retrieves the current
receipt. Previously the late callback was empty, so an ACK received after the
five-second return could not help the caller. The cache stores at most 256
content-free records for one hour, across owner auto-release but not Bridge
restart. It stores no transcript, request fingerprint or replay instructions.

**Keep result navigation native.** Existing brief reads, search and refs answer
what the task is and which evidence matters. Existing `session.settled` events
provide the leaf for a fixed result boundary. A submission ID cannot replace
that leaf: steering, follow-up queues, extension handling and automatic
continuations do not form one Pi turn per Bridge call. Consequently receipts
never announce per-submission completion, success or failure of the user's task.

**Keep continuation simple.** Send to the same session for follow-up work. Keep
the existing default/steer/follow_up/idle_only choices and current model controls.
This round adds no task scheduler, polling loop, whole-history mirror, durable
mutation journal or synthetic turn lifecycle. Extending external-owner completion
events or adding exact work-scoped interruption needs real native lifecycle
identity and evidence, not inference from busy/idle or matching message text.

## Recommended calling pattern

1. Discover the session with `list`; send the instruction and retain both IDs.
2. For `started/queued/handled`, use that native admission outcome. For
   `dispatched`, the external owner invoked Pi; do not resend merely to obtain an
   ACK its public API cannot provide.
3. For `unknown`, call `submission` with both IDs to retrieve a possible late ACK.
   It is a snapshot, not a wait or retry. Missing/still-unknown receipts do not
   prove non-execution.
4. Read the latest overview, then search/expand refs as needed. When subscribed
   to supported owned-run completion events, read the supplied leaf instead.
5. Continue by sending the next instruction to the same session. A new send is
   always new input, regardless of identical text.

Direct MCP callers discover this path in the send/submission descriptions and
schemas. Code orchestration can retain IDs and conditionally query an uncertain
receipt, but must obey the same semantics; it does not gain replay safety or a
per-prompt completion primitive.

## Verification

The complete regression run on Node 26.10.0 with Pi 1.4.0 passed 721 tests,
with the one opt-in Herdr integration test skipped. Formatting and diff checks
passed. Tests use isolated temporary session/agent directories and synthetic
providers; production services and active sessions were not restarted or changed.

The new submission tests cover unknown → handled/started late ACKs, identical
text submitted twice, repeated lookup without dispatch, receipt retention after
owner exit, queued admission remaining separate from settlement, permission
revocation, session identity, expiry and eviction. The existing authenticated
HTTP MCP test now exercises send → completion event → later send → old receipt
lookup → leaf-pinned result read with real Pi. Companion/host tests cover normal,
handled, transformed and queued input, plus synchronous and deferred failures.
