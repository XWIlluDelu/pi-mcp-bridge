# Grok Build / Bot and Bridge completion delivery

Reviewed on 2026-10-24 against Grok Build public main commit
[`2bdd1d6a`](https://github.com/xai-org/grok-build/commit/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8)
(2026-09-29), official product documentation and the current Bridge code.
Grok findings are source/document review; runtime trials below use Pi.

## Verified mechanisms

Grok headless consumes ACP message, tool and plan notifications and renders them
for CLI callers. Its streaming end event carries sessionId, requestId and the
whole-turn stopReason; response text normally arrived in earlier text events.
Ordinary JSON collects text and terminal metadata. The requestId comes from the
native prompt_id, not the JSON-RPC request envelope. ACK evidence must match
sessionId and promptId and exclude replay; generic activity is insufficient.

- [Headless ACP handling](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless.rs#L1752)
- [JSON output construction](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless.rs#L237)
- [Native request identity](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/agent/mvp_agent/mod.rs#L488)
- [Prompt acknowledgement](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/headless/prompt_ack.rs#L22)

The two Grok completion paths share a mapper: persisted TurnCompleted and
immediate prompt_complete derive the same stop reason and agent_result. However,
the producer sets agent_result to null on success; some error paths supply error
detail. The field name and comments alone do not establish successful report
delivery in that notification.
[Shared construction](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/turn_completion.rs#L1),
[actual mapping](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/sampling/error.rs#L396).

Grok exports client-facing notifications from updates.jsonl, while
chat_history.jsonl serves model requests. Its
[session documentation](https://docs.x.ai/build/features/sessions) supports
continuing the same session across TUI, headless and ACP; native IDs provide the
continuity. This supports keeping Bridge Session Context, Runtime Context and
extension memory readers distinct instead of treating model input as the only
record of work.
[Export source](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-shell/src/session/export.rs#L1).

Grok Bot separately documents copying files cited by a Cloud Agent's final report
and attaching them to its reply. That establishes a product delivery behavior,
not the internal connection between that Cloud Agent and open-source Build.
[Files and results](https://docs.x.ai/grok-bot/files-and-results#results-from-cloud-agents).

## Bridge changes and tradeoffs

Before this change, session.settled contained only session_id, leaf_id and aborted.
Its capture and delivery already had useful guarantees: synchronous native leaf
capture, owner-generation/sequence checks, identical retry bodies and fresh read
authorization on every delivery. There was no result preview to reuse.

**Add the useful result to the existing notification.** The event now includes a
bounded excerpt of the last assistant response in this observed run and its
native entry/stop reason. Capture uses the same native session projection as
Session Context, at settlement, including native context edits. It excludes
thinking/tool payloads, never borrows a previous run's answer, and never promotes
empty/error output into a successful report. Later runs cannot alter the frozen
notification. Short results can be understood with zero extra reads; long
results retain their beginning/end and a truncation flag.

**Make deeper reading directly callable.** The event supplies
`read:{session_id,view:"session",leaf_id,preset:"latest"}`. This repairs a concrete
integration gap: the old view-less example could select MC, whose reader cannot
reconstruct a historical native leaf. Explicit native arguments bypass default
memory routing. Subsequent read/search/ref navigation remains unchanged; no new
tool, cache-bound reference or reader-specific branch is needed.

**Keep fact scopes accurate.** Submission receipts describe admission and can
recover a late ACK; they are not Pi turn identities. A session can consume several
steering/follow-up inputs before settling. Notifications describe that run
boundary. Result previews and deeper reading derive from its native projection.
The response's stop_reason is narrower than Grok's whole-turn stopReason and does
not claim task success. These facts cannot be merged merely to obtain one ID.

**Keep file delivery and history storage out of scope.** Report links/path text
already travel in the excerpt. Bridge does not treat their presence as proof of
an artifact, open arbitrary files, or upload them. Pi has no equivalent artifact
delivery contract here; implementing one would require a separate usable file
selection and transport design. A complete ACP update log/replay system would
duplicate state without a demonstrated benefit to current Bridge callers.
Grok headless's ACK-timeout cancellation also does not fit a Bridge that controls
existing local work: uncertainty remains observable without automatic retry or
cancellation.

The excerpt is capped at 2048 UTF-16 units and 4096 JSON bytes, fitting the current
8192-byte owner IPC request. It adds no model call or persistent result store.
The existing signed webhook carries it under the existing read grant; revocation
still stops delivery. See [event API](events.md) for the complete payload.

## Verification

The full Node 26.10.0 / Pi 1.4.0 regression suite passed 731 tests, with the one
opt-in Herdr test skipped. Formatting and diff checks passed. Independent source
review checked native run boundaries, projection, byte limits and reader routing.

The authenticated HTTP MCP trial uses a real isolated Pi process and synthetic
provider. It holds the run before an automatic continuation and confirms that
no settlement is emitted early. The final event arrives once, includes the final
extension-edited response, and remains unchanged after a second run. Passing its
read object directly to MCP retrieves the first run even when a default memory
reader is registered. Existing retry/revocation tests now exercise the enriched
body. Focused projection tests cover hidden/amended messages, empty errors,
previous-run isolation, and Unicode/JSON byte limits.

The first full run exposed a polling race in an unrelated daily-companion test:
the fixture could read its own metadata while a write had truncated it. The
fixture now publishes metadata by rename; the final full run passed. No
production services or active sessions were restarted or changed. Grok Build
itself was reviewed from source, not run locally.
