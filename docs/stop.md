# Remote stop (native Escape-family control)

`stop` cancels current native execution and withdraws queued prompts, while
keeping the live Pi process, session file, history and ownership. This independent
MCP tool follows native Escape-family cancellation; it is excluded from batch.

## Permissions and call

Stop uses the independent, default-denied `command` grant. It neither grants
nor requires `send`.

Stop also requires `read`, because returning the withdrawn contents is mandatory.
A command-authorized caller without read gets `STOP_REQUIRES_READ` **before
any cancellation or queue modification**, rather than a content-free substitute.
Replays and continuation calls recheck both current permissions.

```json
{"session_id":"ps_...","request_id":"stop-1","max_chars":12000}
```

The target must already have a live cooperative runtime. An inactive saved
session returns `skipped/not_running` without launching Pi. An unreachable
owner does not trigger a fallback writer. New Bridge sends to the target are
refused before joining the prompt lock while its stop control is in progress.
Pending sends and bash retain cancellation across permission, receipt and state
I/O, including when stop finishes before that I/O returns. The host endpoint
passes the same admission check through native dispatch. Fresh post-stop inputs
work normally; rejected input remains with its caller.

## Cancellation and complete text recovery

For owned RPC and the public RPC binding, Bridge submits `clear_queue`, `abort`
and `abort_bash` in that order without waiting for an ACK between their submission.
This avoids letting the active run consume its queue while waiting for clear's
response. It stores the returned text privately, waits for native cancellation
ACKs, then withdraws inputs queued while cancellation was settling.

The SDK binding similarly calls public `clearQueue()`, `abort()` and
`abortBash()` before yielding, preserves text, and drains its queues again after
abort returns. `AgentSession.abort()` cancels agent, retry, compaction and
branch-summary operations; independent `!bash`/`!!bash` needs `abortBash()`.
Native tool cancellation still depends on tools cooperating with their signal.

`withdrawn_text` contains complete native-ordered text: steering then follow-up,
joined with two newlines, as in native queued-text restoration. This grouping
preserves each queue's order rather than interleaving original enqueue times.
A host may instead return its whole restored editor text, labelled
`includes_editor_draft:true`.

The default 12,000 and maximum 32,768 `max_chars` bound the serialized
`{"withdrawn_text":"..."}` content of each response, excluding receipt/cursor
metadata. Long text is never silently truncated: `next_cursor` and
`withdrawn_complete:false` require another call with the **same request ID**.
`text_offset`/`total_text_units` count decoded UTF-16 code units; pages do not
split surrogate pairs. Concatenate `withdrawn_text` in page order until complete.
Continue with `cursor`, adjusting the budget if desired. A cursor request only
queries an existing receipt; an unknown request ID returns `RECEIPT_NOT_FOUND`.
A misbound/stale cursor is rejected without another cancellation.

Recovery text uses the existing private Journal storage primitive under the
owner attachment directory's `stop/receipts/`. The Bridge's ordinary mutation
receipt references its native identity/generation; queued text is not written
into the transcript or exposed through send's non-content receipt. It remains
retrievable after Bridge restart and after the live owner goes away.

`accepted/native_ack` confirms native public API acknowledgement;
`accepted/requested` indicates host-initiated cancellation. A lost ACK resolves to
`unknown`; captured withdrawn text remains retrievable by querying the same request ID.
Callers must reuse the request ID for recovery rather than issuing a new stop ID,
which could interrupt a subsequent run. Cancellation covers native execution and
queued prompts; already executed effects remain. Extensions must coordinate
cancellation of their own asynchronous preflight and background work.

## Generic hosts and companion compatibility

`reserveHostSession(...).ready(callbacks)` accepts an optional
`stop({sessionFile,sessionId,onWithdraw})` callback. It must request the native
agent-family **and independent bash** cancellations, withdraw the native queues,
and call/await `onWithdraw({steering,followUp})` while it still has their full
text (including on an ACK failure). A TUI host can supply
`onWithdraw({text,includesEditorDraft:true})` for joined restored text. Then
return `{acknowledgement:"native_ack"|"requested",coverage:"agent_and_bash"}`.
Missing capture/invalid coverage is not a successful stop.

Public SDK/RPC bindings provide this callback when their session/client exposes
all three cancellation/queue methods. They cover the native session queues;
a host with additional UI/admission queues must withdraw those through its callback.

**Ordinary companion lacks the public APIs for full stop.**
In TUI, public `ctx.abort()` synchronously restores session and TUI compaction
queues into the editor, and public editor get/set can recover the joined text
while retaining an existing draft. Text recovery is not the blocker.
However, `ExtensionContext` exposes neither independent bash cancellation nor
bash state. RPC context also lacks the public queue-withdrawal method.
Companion/old-host requests therefore return `STOP_UNSUPPORTED` before cancellation.
A TUI host that owns a public `AgentSession` can implement the callback;
`main({extensionFactories})` alone does not expose that session.

## Verification

Offline SDK/RPC tests verify: running agent cancellation, multi-page queued text
recovery, independent bash termination, retry, manual compaction, branch summary,
same-process continuation, host IPC, lost ACK recovery, restart replay, cursor
binding and permission enforcement. The ordinary RPC companion returns
`STOP_UNSUPPORTED` while continuing normal operation.
