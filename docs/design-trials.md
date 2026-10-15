# Design experiments

These experiments evaluate [related-project ideas](reference-projects.md) using
Pi 1.1.0 native RPC, SDK and TUI paths, synthetic sessions, an offline provider
and loopback MCP HTTP. Prototype behavior is distinguished from the public API.

## Findings

| Question | Observed result | Design implication |
| --- | --- | --- |
| Can group selection simplify exact reads? | A complete latest user span needed one call instead of overview plus two expansions. | Separate selection from bounded delivery; retain native projection and source references. |
| Can continuation survive appends? | A captured selection finished unchanged; the existing pinned-leaf cursor became stale. | Distinguish finishing a capture from reading current Context. |
| Does per-session scheduling help? | Two independent 150 ms waits took about 151 ms instead of 302 ms. | Independent batch targets need not block each other. |
| Does recovery need a new event store? | Existing receipts recovered a disconnected native send, including after Bridge restart, without redispatch. | Keep receipt recovery separate from live observation. |
| Can a generic host announce its capabilities? | Two concurrent attach calls shared one publication to the existing SDK writer. | Discovery can simplify cooperative integration; it does not supply missing host controls. |
| Can native TUI entry be automatic? | A fresh TUI's startup `/bridge-join` waited for the old writer and opened the target afterward. | An entry wrapper is viable without a replacement terminal client. |
| Does closing that TUI preserve work? | Graceful exit and pane closure ended the task; interrupted registry updates need their own recovery. | Process survival and registry recovery are separate lifecycle problems. |

## Reading: selection and delivery

The prototype uses Bridge's `recordsFor(..., {view:'context'})`, backed by Pi's
native session projection. It annotates chronological user spans, unions selected
head/tail spans, and preserves native tool-call references. It does not assign
exclusive causal ownership of output to individual steering inputs. Summaries,
system checkpoints and a compaction-retained prefix without its old input remain
explicit records rather than invented user groups.

The comparison below uses the same **4096 UTF-16-unit cap on the entire serialized
structured response**, including its envelope. Existing reads were bounded with
Bridge's existing `rebudgetRead`; ordinary `max_chars` does not itself impose that
whole-response cap. Complete selected native records were reconstructed and
compared in order, including Unicode and escaped large results.

| Required content and access strategy | Calls | Serialized UTF-16 units |
| --- | ---: | ---: |
| All 12 native records, existing context read | 26 | 101,465 |
| Same complete records, captured grouped read | 23 | 90,624 |
| Latest two complete records, existing known entry IDs | 2 | 1,691 |
| Same latest records, first overview then exact expansion | 3 | 5,563 |
| Same complete latest span, grouped selection | 1 | 1,045 |
| Large selected span, existing context read | 12 | 43,747 |
| Same complete span, captured grouped read | 11 | 38,990 |

The existing overview exposed the latest input and answer in one call in this
fixture. Group selection simplifies retrieving **complete content**. Full-context
savings come from envelope and page packing; grouping does not compress that content. The prototype's
full default still returns chronological content, so it does not by itself solve
recent-first presentation.

After an append between pages, existing continuation returned `STALE_CURSOR` even
with the original leaf pinned. Completing that original selection then required
13 successful calls plus the failed continuation. The capture finished in 11
calls. Actual SDK steering and SessionManager-created compaction, branch and
context-edit fixtures were exercised: fresh captures matched the new effective
projection, while old captures remained finishable and reported source movement.
SessionManager fixtures supplied summaries directly; they measure saved-state
projection.

The capture is an in-process research object. Retained serialized rows occupied
80,279 UTF-16 units for full context and 779 for the latest span, not measured heap
sizes. It loses captures on restart. A service design still needs capture lifetime,
access checks and refresh semantics. These saved-record captures exclude partial
streaming messages and provider-request transformations.

## Scheduling: independent targets

The batch prototype retains existing validation, per-item permissions, receipts,
result order and response budgeting. It creates an ordered lane per session;
creates use a folder lane. Lanes are scoped to one batch, not a new global queue.

Two warmed native RPC sessions each performed a 150 ms settlement wait with no
new settlement. Across five alternating local runs, the median batch duration was
**301.9 ms serial versus 151.3 ms parallel**. In a separate run, a send to session B
behind session A's 250 ms wait reached its native ACK in **253.0 ms versus 1.7 ms**.
The combined parallel batch still returned after about 252 ms: early execution
of B is not early delivery of its individual result to the MCP caller.

Same-session order, mixed small/large read fragments and cursors, and repeated
create request IDs were checked. These measurements isolate local scheduling;
they are not remote-network or provider-throughput measurements. The public batch
implementation remains serial while the prototype is evaluated.

## Observation and recovery

A real loopback MCP HTTP connection was destroyed while a native input hook held
admission. The same request ID later returned its accepted receipt. Native history
contained one input and the offline provider ran once. Repeating the request with
its body did not resubmit it. After Bridge restart, receipt-only lookup returned
the same result without starting a Pi runtime. This supports keeping the current
receipt mechanism rather than adding an outbox for prompt retries.

A separate native SDK stream tested an ordered snapshot/subscription boundary.
Taking a snapshot, allowing one update, then subscribing lost 64 live characters
in that controlled interleaving. Capturing state and registering the listener at
one synchronous event boundary reconstructed the complete stream. Authoritative
message-end replacement also repaired the late subscriber's final display.
A deliberately slow consumer stopped accumulating at 16 queued events and
recovered from current state, without a durable event log. These are single-
generation live-display experiments, not an effective-Context snapshot service.

The stream also clarified where optimization is useful. For 4096 output
characters in 64 deltas, serializing SDK cumulative update objects used 322,752
bytes; native RPC text-delta records used 20,352 bytes. **Pi 1.1 already removes
cumulative snapshots on its RPC wire.** An additional Bridge RPC compactor would
not deliver that saving again. A future SDK event relay should avoid reintroducing
cumulative serialization.

Native `get_entries(since=append_tail)` returned the exact two-entry suffix after
a second input: 4,796 entry bytes versus 11,949 for all seven entries. This provides
efficient append tracking, while branch switches and compaction continue to require
explicit projection checks.

## Cooperative host discovery

Two actual Pi extensions communicated through `pi.events`: one advertised an
existing SDK host, the other discovered it. Two concurrent attach calls shared
one publication. Bridge read and send reused that writer, spawned no process,
and continued to enforce its grants. Reservation still preceded native session
open; discovery was not permission to create another writer.

The ordinary extension context lacks `executeBash` and `clearQueue`. Discovery
can advertise a cooperating host's capabilities; native control still requires
that host's public callbacks. The existing explicit binding remains sufficient
without a general registry or daemon.

## Native TUI entry and closure

A fresh native interactive Pi accepted `/bridge-join ps_ID` as its positional
startup command. The target was **not** passed to initial `--session`. Existing
Bridge join code fenced new mutations, drained two admitted inputs, waited for
native EOF shutdown, observed the old process exit with code 0 and no signal,
and reserved the target for the TUI before native `session_before_switch`.
The resumed TUI saw both responses and an entry appended by the shutdown hook.

A representative run took 603 ms from launch to admission fencing and 3.0 s to
observed join completion, including an intentional 2.1 s shutdown hook and queued
work. The total therefore includes intentional shutdown and queued work, not just
launcher overhead. The entry shape works with the original TUI; normal-resource
loading and launcher failure UX still need product integration.

After confirmed text streaming, graceful Ctrl+D exited normally. The user input
remained saved, but the partial assistant response did not, and the task did not
survive. Explicit cold-resume reset followed by a new input succeeded; the
interrupted input was not automatically replayed.

Abrupt terminal closure can interrupt a registry update independently of the
handoff barrier. With the non-recovering lock implementation, a dead TUI's lock
made confirmed reset fail with `ATTACHMENT_REGISTRY_BUSY`; graceful cleanup
allowed reset. The crash fixture also exercises recovery of that legacy lock.

Current [`registryTransaction`](../src/attachments.mjs) publishes complete
identities and serializes exact-dead-owner recovery while protecting replacement
inodes. Public regressions cover current/legacy crashes and concurrent recovery;
the public reset CLI recovered the abrupt-close residue without starting a writer.
See [registry recovery](runtime-handoff.md#interrupted-registry-updates) for its
coordination boundary.

## Further evaluation

Read selection, concurrent batch, discovery and streaming probes remain research
prototypes; they are not registered MCP endpoints. Registry recovery is implemented
and covered by public regression tests.

The strongest candidates for further work are per-session batch scheduling,
selection/delivery separation, and fresh-TUI automatic entry. Existing receipt
recovery and native RPC delta encoding already solve important parts of the
problem; adding parallel systems would not improve those parts.

A useful next evaluation would compare current read with a tool-exposed selector:
retrieve complete recent spans and large results, then distinguish finishing a
captured selection from refreshing Context after an append or compaction.
This requires an isolated endpoint for the selector.
