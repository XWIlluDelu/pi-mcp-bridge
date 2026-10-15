# Design lessons from related projects

Read alongside the [target experience](redesign.md). Links pin inspected source
revisions; each comparison examines its implications for Bridge.
[Design experiments](design-trials.md) evaluate these ideas on native Pi runtimes.

Bridge adapts an existing Pi environment, including runtimes it does not own.
Codex/OpenCode control their agent engine; HAPI controls its wrapper and input path;
Pi extensions operate inside an existing host. These different scopes of control
determine which consistency and lifecycle properties each architecture can offer.

## Read organization: Codex and OpenCode

Codex separates turns from their typed items. Its
[turn/item API](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/v2/thread.rs#L1738-L1841)
can select recent turns and then page their content. The
[history cursor](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/thread-store/src/local/thread_history/read.rs#L30-L45)
contains thread identity, an ordinal, scope and anchor inclusion, rather than a
revision of the entire file. Its
[paging implementation](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/thread-store/src/local/thread_history/segment_paging.rs#L450-L528)
can return a reverse cursor including the boundary item, useful for rereading an
item that is still changing. Ordinary append need not invalidate older pages.
Selection order and returned timeline order can therefore be separate choices.

**Content organization and effective-context projection are separate problems.** Codex's
[display projector](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server-protocol/src/protocol/thread_history_projection.rs#L78-L99)
ignores model-history replacement records (`RolloutItem::Compacted`), even though
it can still display a compaction event. Its separate
[model-context reader](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/rollout/src/model_context.rs#L18-L56)
uses replacement history at a suitable compaction checkpoint. Display cursors
track visual history, whereas effective model Context changes across compaction
checkpoints. Codex rejects updated-item paging across multi-segment forks; that
restriction applies to update replay, not ordinary chronological history paging.

OpenCode makes this distinction especially visible:
[`store.messages` and `store.context`](https://github.com/anomalyco/opencode/blob/bdf4793286f754a1ba9827ca5dea1f0bdad63f12/packages/core/src/session/store.ts#L140-L180)
use different paths. The former pages transcript rows; the latter applies the
[latest applicable compaction boundary](https://github.com/anomalyco/opencode/blob/bdf4793286f754a1ba9827ca5dea1f0bdad63f12/packages/core/src/session/history.ts#L17-L109).
For a simple log `U1, A1, C, U2, A2`, where `C` is a completed compaction,
transcript reads retain all five while this context path starts at `C`.

For Bridge, the useful lesson is that the **selection unit need not be the delivery
unit**. A user-input group can keep related work together even when a large tool
result needs several bounded responses. Pi's effective projection already exists;
the unresolved work is organizing and delivering it, not replacing it with another
agent's history model. Native item/call IDs preserve references, while a running
turn with steering inputs does not establish exclusive attribution to one send.

Continuation needs explicit semantics for finishing a captured selection versus
following changing contents. An unrelated append and a compaction that changes
the selected Context need different treatment. Stable anchors help express that
difference. The open question is how callers express selection and continuation
with fewer calls while retaining the full-context default.

## Reconnect: snapshot and subscription ordering

Codex routes a live resume request through the existing thread's listener.
The [resume handler](https://github.com/openai/codex/blob/bb64b894fd67158be0f874872e6d7bfe717e7368/codex-rs/app-server/src/request_processors/thread_lifecycle.rs#L721-L970)
combines persisted history with current in-memory turn state, attaches the
connection, returns the snapshot and replays pending requests. This happens at
the same listener boundary that handles conversation events, rather than as an
uncoordinated read followed by a later subscription.

The useful lesson is to coordinate the observation boundary, rather than treat
snapshot and subscription as unrelated calls. Codex controls the thread's event
loop; Bridge can coordinate its own or a cooperating host's operations, but cannot
assume that it controls every native extension task. This coordinates the live
connection boundary without requiring complete historical event replay or
immutable snapshots of provider payloads.

[nucleoid/pi-remote](https://github.com/nucleoid/pi-remote/tree/d539917f6c2f1edc3c6baf54f5be1ddb4ce4a363)
provides a smaller Pi-specific example. Its
[replay subscription](https://github.com/nucleoid/pi-remote/blob/d539917f6c2f1edc3c6baf54f5be1ddb4ce4a363/packages/daemon/src/subscriptions.ts)
captures an event high-water mark, replays through it, buffers incoming live events
and deduplicates at the transition. That event log is not Pi's effective Context.
Its separate daemon owns the event log and the replay boundary.

OpenCode offers a lighter alternative: bounded live subscriber queues and
refetch after reconnect, rather than complete event replay. For Bridge, recovering
an operation's receipt, reading current Context and replaying every intermediate
event are three different needs. The existing [journal](../src/journal.mjs) already
preserves operation identity and uncertain outcomes. Improving read continuation
may be enough for MCP callers. An event store becomes useful when callers need
intermediate events that receipt lookup and current-state reads cannot recover.

## Generic host discovery: pi-sessions

[pi-sessions' host contract](https://github.com/thurstonsand/pi-sessions/blob/bb1184c1ec4e8c5b1064a2cb3dd230702be630a7/extensions/hosts/contract.ts)
uses a versioned Pi extension event to register named hosts with `launch`,
`listSessions` and `wake` callbacks. Its
[registry](https://github.com/thurstonsand/pi-sessions/blob/bb1184c1ec4e8c5b1064a2cb3dd230702be630a7/extensions/hosts/registry.ts)
rejects competing host advertisements for the same session. The
[message router](https://github.com/thurstonsand/pi-sessions/blob/bb1184c1ec4e8c5b1064a2cb3dd230702be630a7/extensions/session-messaging/message-router.ts)
coalesces concurrent wake requests per target and waits for messaging availability.

The useful distinction is between a host advertising responsibility for a session,
a reachable messaging endpoint, and actual execution activity. A live socket does
not establish idle; a dormant advertisement is not permission to launch.

Bridge already has generic SDK/RPC bindings and a
[reserve-before-open ownership contract](host-adapter.md). This comparison supports
that frontend-independent direction rather than demonstrating a need for another
registry. The remaining question is how an existing host publishes capabilities
and coordinates its lifecycle through public interfaces. Discovery alone cannot
reserve a writer or make an uncooperative RPC process controllable.

## Ordered inputs and independent sessions: HAPI and OpenCode

HAPI's Pi integration reserves a monotonic arrival sequence **before** asynchronous
input preparation. Its
[small prompt queue](https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/pi/promptQueue.ts#L5-L72)
uses that sequence rather than preparation-completion order. This is directly
relevant when independent session lanes run concurrently: preserve order within
each lane without serializing the whole batch.

HAPI also separates the append-log cursor from the active branch leaf. Its
[history synchronization](https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/pi/conversationHistory.ts#L188-L282)
establishes a baseline before releasing prompts, serializes incremental reads,
and advances to the last appended entry. A fork can move the leaf backwards;
using it as append progress would replay old entries. Its FIFO pairing of local
request IDs to user entries assumes controlled traffic. Bridge also shares native
and extension-origin work, so that attribution assumption does not carry over.

OpenCode's
[run coordinator](https://github.com/anomalyco/opencode/blob/bdf4793286f754a1ba9827ca5dea1f0bdad63f12/packages/core/src/session/run-coordinator.ts#L60-L195)
keeps one execution per key while unrelated keys run independently. Interrupt
reaches the executor directly instead of waiting behind normal execution. This
is execution coordination, not a complete FIFO for reads, sends and admin
operations, nor Bridge's queue-withdrawing stop contract.

For Bridge, compare **operation admission order, native queue order and execution
completion** separately. Serial admission does not require waiting for each model
response before admitting another input. Conversely, adding a Bridge-owned prompt
queue would add another place whose contents stop must recover. HAPI's queue helps
explain ordering across asynchronous preparation; it does not establish that Bridge
needs the same queue. Cross-session batch concurrency remains a local scheduling
problem alongside existing preflight, receipts, captured reads and response budgets.

HAPI's extension-dialog replies address interactive consent. Bridge's operation
grants and project/session inheritance remain a separate authorization problem.

## Streaming costs and slow observers

[vstack's Pi session bridge](https://github.com/vanillagreencom/vstack/tree/be6f93fa861ab5993305defa36b6aa56835834f2/pi-extensions/pi-session-bridge)
is an extension attached to the running Pi. Its
[event sanitizer](https://github.com/vanillagreencom/vstack/blob/be6f93fa861ab5993305defa36b6aa56835834f2/pi-extensions/pi-session-bridge/extensions/event-sanitizer.ts#L158-L275)
sends incremental text/thinking/tool-argument updates instead of repeating the
growing partial message on every delta. Its
[socket send path](https://github.com/vanillagreencom/vstack/blob/be6f93fa861ab5993305defa36b6aa56835834f2/pi-extensions/pi-session-bridge/extensions/session-bridge.ts#L976-L1002)
disconnects clients whose unsent backlog exceeds its bound; one response can
exceed that bound, so this is not a per-response size limit.

These mechanisms explain concrete streaming costs: repeatedly serializing
cumulative output and retaining data for a slow client. For Bridge, the relevant
questions are how much work its native callbacks perform and how much data an MCP
caller needs. A polling tool and a token-streaming UI have different delivery needs;
performance decisions should follow the actual path used by Bridge.

## Native TUI handoff

| Project | What actually shares or survives | Difference from the target |
| --- | --- | --- |
| [Wherever](https://github.com/wighawag/wherever/blob/d181cb26ae668c2d2711d18442a590b68b7d0959/server/src/session-pool.ts#L2527-L2649) | A canonical-file keyed pool routes viewers to a native companion or an SDK session and retains subscriptions across owner replacement. | Native CLI registration aborts/disposes the existing SDK agent; it does not wait for completion. CLI disconnect may create a new SDK session from disk, not preserve the old process or task. |
| [HAPI](https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/pi/runPi.ts#L198-L309) | A wrapper owns one native Pi RPC child and fans it out to remote clients. | Pi has no local TUI input path here. Its [Switch handler](https://github.com/tiann/hapi/blob/5847b034e5cb84f2617766945c994b7905c5c03e/cli/src/pi/runPi.ts#L1424-L1434) changes control metadata, not the frontend; handoff-local shuts down the child. |
| [pi-server](https://github.com/marcfargas/pi-server/tree/5b5424c89f95acb973a59bc1424c5da2a1821252) | A daemon owns a native Pi RPC child; its separate Ink terminal client can disconnect while the daemon continues. | The terminal client is not native Pi TUI. This demonstrates a daemon/client topology, not attachment of native TUI to an existing RPC process. |

The central lesson is that switching a frontend, transferring a writer and
preserving a running task are separate lifecycle operations. Wherever's native
companion is relevant, but socket disconnection alone does not confirm that the
writer process has exited. Pi-server makes the terminal a client from the start;
that differs from an ordinary Pi TUI already owning the runtime.

For Bridge, natural entry needs coordination before opening the target's writer.
The existing [idle handoff](runtime-handoff.md) provides evidence for one controlled
transfer path; a launcher and an upstream pre-open seam have different integration
and UX costs to investigate. Terminal-close survival is a separate tradeoff: the
target accepts interruption when survival is unavailable, so preserving native TUI
can take priority over introducing a replacement client.
