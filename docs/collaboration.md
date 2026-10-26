# Working with a Pi session

Bridge lets an external agent continue work in a local Pi session using its
environment, extensions and history. Start from a useful overview, send the next
instruction, and read further only when the outcome needs explanation or evidence.

## Calling workflow

1. Use `list` to find an authorized session and its current activity. Start with
   `read({session_id})` for the last three input turns in source order. Increase
   `range.recent` for more background, or use `search` to locate a decision or
   tool result. Expand returned refs with `read`.
2. For completion notifications from Bridge-owned RPC execution,
   [subscribe before sending](events.md). External TUI/RPC/SDK owners have their own
   lifecycle and are outside this event's scope.
3. Send the instruction to that session and retain `session_id` and
   `submission_id`. `started`, `queued` and `handled` report native admission.
   `dispatched` confirms an external owner invoked Pi's public API, whose input
   handling may still transform or handle the message.
4. If the result is `unknown`, query `submission` with both IDs for a possible
   late acknowledgement. A missing or still-unknown receipt does not establish
   failure; another send would be new input.
5. On `session.settled`, the result excerpt may be enough to understand a short
   outcome. For more context, pass `data.read` directly as the read tool's
   arguments. These arguments select Session Context at the completed leaf, even
   when a memory reader handles default reads.
6. Send the next instruction to the same session. Use `list` for current activity
   and the reading tools for task progress and evidence.

Direct MCP calls and code orchestration use the same workflow. Code can retain
IDs and choose the next call from the returned status; repeating a send or batch
still repeats its mutations. See the [API](api.md) for arguments and outcomes,
[reading](reading.md) for source selection and navigation, and [events](events.md)
for subscriptions and delivery.

## Identity and result boundaries

| Value                      | Identifies                                    | Use                                                         |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------- |
| `session_id`               | The canonical saved Pi session                | Continue work and observe current activity.                 |
| `submission_id`            | One Bridge send/create admission attempt      | Retrieve its receipt, including a matching late native ACK. |
| Event `leaf_id` and `read` | The native branch boundary when a run settled | Read that result after later work has started.              |

Pi steering, follow-up queues and automatic continuations can consume several
inputs in one run. Admission receipts therefore describe delivery/admission;
completion notifications describe a session run. Neither establishes success of
the user's task. The notification's `stop_reason` is the final assistant message's
native termination reason.

The companion's public `sendUserMessage()` returns void; SDK `prompt()` can resolve
after input handling or a full run. Confirmed invocation is useful evidence even
without an admission callback. Owned RPC has matching native ACKs, so Bridge
retains those receipts in a bounded memory cache. These choices let the caller
resolve uncertainty without inferring delivery from conversation text. The
[receipt contract](api.md#submission-receipt) defines retention and authorization.

Completion excerpts and historical reading use the same native session
projection. Capturing at settlement keeps later replies out of the notification.
Explicit Session Context also avoids asking a current-memory reader to recreate
a past native leaf. Runtime Context remains a request-stage snapshot; an
extension reader can expose its current stored memory through the shared
[module contract](compatibility.md).

## Design references

The comparisons below were reviewed on 2026-10-24 against Pi 1.4.0,
[Codex `970111f6`](https://github.com/openai/codex/commit/970111f6cb62cc02fe36a82ea7d71b37a2889c97)
and [Grok Build `2bdd1d6a`](https://github.com/xai-org/grok-build/commit/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8).
They support using native evidence and keeping read, admission and completion
boundaries explicit; their protocols are not Bridge's implementation contract.

### Codex and dot

Codex App Server has native Thread / Turn / Item identities. `turn/start` returns
Core's actual start-or-steer outcome and turn identity; busy input can join an
existing turn. `turn/steer` accepts `expectedTurnId`, and `turn/completed` carries
the same identity, final status and error. Turn/item reads support both summaries
and expansion. Pi does not expose an equivalent turn identity for every Bridge
submission. [Turn routing](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs#L661),
[Core decision](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/codex_thread.rs#L412),
[steering](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/turn.rs#L317),
[completion](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/bespoke_event_handling.rs#L1378),
[turn/item reads](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1760).

Codex Core also notes that dropping a reply waiter does not retract a queued
request. Correlation IDs alone do not establish replay safety.
[Submission source](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/core/src/session/mod.rs#L1115).
The observed dot MCP wrapper correlates sends, completion callbacks and latest
turns, but its exposed read parameters differ from App Server. The public
[harness](https://openai.com/index/unlocking-the-codex-harness/) and
[dots](https://openai.com/index/introducing-dots/) articles do not specify the
private `cloud_threads` protocol.

### Grok Build and Bot

Grok headless consumes ACP message, tool and plan events. Its streaming terminal
event carries native `sessionId`, `requestId` and whole-turn `stopReason`; text
normally arrives in earlier events. Ordinary JSON output aggregates the text.
ACK evidence must match the native prompt/session identity and exclude replay.
[Headless events](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless.rs#L1752),
[JSON output](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless.rs#L237),
[native identity](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L488),
[ACK matching](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless/prompt_ack.rs#L22).

Persisted `TurnCompleted` and immediate `prompt_complete` share a result mapper,
but the producer sets `agent_result` to null on success. Some errors supply detail;
the field does not establish successful report delivery. Bridge's excerpt instead
comes from its existing native projected response, reducing follow-up reads.
[Shared mapper](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/turn_completion.rs#L1),
[producer](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/sampling/error.rs#L396).

Grok exports client-facing `updates.jsonl` while model requests use
`chat_history.jsonl`; its session identity supports continuation across TUI,
headless and ACP. This is a useful distinction between the record a caller reads
and the model's current input. [Export](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/export.rs#L1),
[sessions](https://docs.x.ai/build/features/sessions).

Grok Bot documents copying files cited in a Cloud Agent's final report into its
reply. The public material does not establish that agent's connection to
open-source Build. Bridge delivers report text and native source context; file
delivery would require a separate artifact-selection and transport contract.
[Bot files and results](https://docs.x.ai/grok-bot/files-and-results#results-from-cloud-agents).
