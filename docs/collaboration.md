# Working with a Pi session

Bridge lets an external agent continue work in a local Pi session using its
environment, extensions and history. Start from a useful overview, send the next
instruction, and read further only when the outcome needs explanation or evidence.

Complete [local setup](../README.md#start-locally) and grant the intended
[operations](configuration.md#seven-independent-rights) before this workflow.
Discovery, history reading and execution have independent permissions; finding
a session does not authorize sending to it, and a known ID can be usable even
when discovery is denied.

## Calling workflow

1. Use `list({})` to find an authorized session and its current activity, or use
   a known `session_id` directly with an authorized operation. For new work,
   choose a project from `creatable_projects` and call `create({project})` to
   save an empty session. For existing work, start with `read({session_id})`
   for the last three input turns in source order. Increase `range.recent` for
   more background, or use `search` to locate a decision or tool result. Expand
   returned refs with `read`.
2. For completion notifications, [subscribe before sending](events.md).
   Bridge-owned RPC and ordinary TUI/RPC companions connected to this Bridge
   support `session.settled`. For a new session, subscribe to its saved ID before
   sending the first task.
3. Call `send({session_id,text})` and retain `session_id` and any returned
   `submission_id`. `started`, `queued` and `handled` report native admission.
   `dispatched` confirms an external owner invoked Pi's public API, whose input
   handling may still transform or handle the message.
4. If the result is `unknown` and includes a `submission_id`, query `submission`
   with both IDs for a possible late acknowledgement. If the response or receipt
   is unavailable, inspect current activity and history before deciding on new
   input. Neither a missing receipt nor a still-unknown one establishes failure;
   another send would be new input.
5. On `session.settled`, the result excerpt may be enough to understand a short
   outcome. For more context, pass `data.read` directly as the read tool's
   arguments. These arguments select Session Context at the completed leaf, even
   when a memory reader handles default reads.
6. Without notifications, use `list({session_id})` for sampled activity and
   `read({session_id})` for current progress and results when needed. An idle or
   saved state alone does not establish the task's outcome. Review the result,
   then send the next instruction to the same session.

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
inputs in one run. A reading [input turn](reading.md#turn-range-and-content)
groups an input with following projected content; it is not a completion unit.
Admission receipts therefore describe delivery/admission; completion
notifications describe a session run. Neither establishes success of
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

The design draws on native operation/result correlation in
[Codex App Server](https://github.com/openai/codex/blob/970111f6cb62cc02fe36a82ea7d71b37a2889c97/codex-rs/app-server/src/request_processors/turn_processor.rs#L661)
and [Grok Build's completion mapping](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/turn_completion.rs#L1),
and on Grok's separation of [client-facing session records](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/export.rs#L1)
from model input. Reviewed with Pi 1.4.0 on 2026-10-24, these references informed
Bridge's separate admission receipts, settlement results and context views. Pi's
native evidence defines the implemented boundaries described above.
