# Remote stop (native Escape-family control)

`stop` cancels current native execution and withdraws queued prompts, while
keeping the live Pi process, session file, history and ownership. It is not
Ctrl+C, shutdown, release, deletion, or an arbitrary RPC/slash-command executor.
It is an independent MCP tool, not an ordered batch item.

## Permissions and call

Stop requires the independent, default-denied `command` grant.
It neither grants nor requires send access.

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
refused while its stop control is in progress; the host endpoint similarly
fences its Bridge admissions during the callback.

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
joined with two newlines. Each queue retains its order. A host may return its
whole restored editor text, labelled `includes_editor_draft:true`.

The default 12,000 and maximum 32,768 `max_chars` bound the serialized
`{"withdrawn_text":"..."}` content of each response, excluding receipt/cursor
metadata. Long text is never silently truncated: `next_cursor` and
`withdrawn_complete:false` require another call with the **same request ID**.
`text_offset`/`total_text_units` count decoded UTF-16 code units; pages do not
split surrogate pairs. Concatenate `withdrawn_text` in page order until complete.
Continue with the returned nonempty `cursor` and original session/request ID;
page budgets may change. This queries the existing receipt. Do not use a new
request ID to retry an uncertain stop.

Recovery text uses the existing private Journal storage primitive under the
owner attachment directory's `stop/receipts/`. The Bridge's ordinary mutation
receipt references its native identity/generation; queued text is not written
into the transcript or exposed through send's non-content receipt. It remains
retrievable after Bridge restart and after the live owner goes away.

`accepted/native_ack` means the native public calls acknowledged;
`accepted/requested` means the host requested cancellation. Neither is exact
task completion or rollback of already executed tools. A lost ACK is
`unknown`; already captured withdrawn text can still be returned. Reuse the
request ID to recover it, never send a new ID merely to retry an uncertain stop:
that could interrupt a later run. Cancellation does not stop arbitrary extension
preflight/background work; Pi's before-agent-start hooks have no universal
cancellation barrier.

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
a host with additional UI/admission queues must withdraw them through its own
generic callback.

**Ordinary startup-loaded companion remains unsupported for full stop-all.**
In TUI, public `ctx.abort()` synchronously restores session and TUI compaction
queues into the editor, and public editor get/set can recover the joined text
while retaining an existing draft. Text recovery is not the blocker.
However, `ExtensionContext` exposes neither independent bash cancellation nor
bash state. RPC context also lacks the public queue-withdrawal method.
Companion requests return `STOP_UNSUPPORTED` before cancellation. A TUI host
with a public `AgentSession` can implement the callback;
`main({extensionFactories})` alone does not expose it.

## Verification

Disposable offline SDK/RPC fixtures cover agent execution, queued text over one
page, independent bash, retry, compaction, branch summary, same-process
continuation, host IPC, lost ACK recovery, replay and permission separation.
The ordinary RPC companion refuses full stop and remains usable.
