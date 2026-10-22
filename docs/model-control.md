# Model settings and native controls

Prompt settings and compaction act on sessions:

| Operation                | Behavior                                | Owner                                       | Permission                                 |
| ------------------------ | --------------------------------------- | ------------------------------------------- | ------------------------------------------ |
| `send`/`create` settings | Apply model/thinking, then submit input | Proven-idle Bridge-owned RPC                | `send` / `create`                          |
| `compact`                | Native context compaction               | Owned RPC idle; attached explicit interrupt | `send`; `interrupt:true` also needs `stop` |

### Pi 1.3.0 empty-context resume limitation

Pi 1.3.0 restores saved model/thinking only when the current branch already
produces context messages. A published session whose first input was handled
without a run, or refused before dispatch, can have no such messages. In that
case native selection entries may have been written, but after normal
release the next cold resume still chooses native defaults instead of restoring
them. A session with context messages follows the normal restoration path.

This is a Pi SDK/CLI startup limitation, not a missing Bridge write. Bridge
does not insert messages, keep a separate preference store or turn saved
selections into launch overrides. Correcting
startup semantics requires a native Pi fix and validation of the actual CLI;
changing only Bridge's SDK dependency is insufficient.

## Prompt model and thinking settings

```json
{
  "session_id": "ps_…",
  "text": "Review the change",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Both `send` and `create` accept `model` and/or `thinking_level`, including create's first prompt. Settings require text or images. They share the prompt's session lane. These settings require proven-idle submission.

- Model only: Pi selects the model and preserves or adjusts thinking natively. The result reports the verified effective model and thinking level.
- Thinking only: validate against the current native model and change its level.
- Both: validate the requested level against the target model before changing either.
- Neither: keep native session behavior. A cold start normally restores saved selection, subject to explicit launch overrides, model availability and the [Pi 1.3.0 empty-context limitation](#pi-130-empty-context-resume-limitation).

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, restricted to the native target's supported set. Unsupported explicit levels return `THINKING_LEVEL_UNSUPPORTED`; unknown reasoning support returns `THINKING_SUPPORT_UNKNOWN`. Global user defaults are unchanged.

Explicit settings require a proven-idle Bridge-owned RPC with no pending input. Busy returns `MODEL_SELECTION_BUSY`; `idle_only` skips busy work without changing settings. Unproven idle returns `MODEL_SELECTION_IDLE_UNCONFIRMED`. Shared hosts and companions return `MODEL_SELECTION_UNSUPPORTED` before settings or input dispatch. Plain queued sends continue to use native settings when consumed. Immediately
before prompt dispatch, explicit settings and image support are checked against
the current native selection. A conflicting local change refuses the prompt;
Bridge does not restore an old model to make preflight pass.

Selection and prompt submission use separate native commands. The Bridge serializes its own calls, rechecks identity and execution state, uses the request's [receive-time permission snapshot](configuration.md#request-permission-snapshots), and omits native queue behavior on a settings-bearing prompt so a hook that starts concurrent work causes refusal. Pi offers no atomic settings-plus-input transaction or per-message settings binding against independent native extension work. A failed prompt or later setting step can leave an earlier native setting in place; settings are not rolled back.

Only explicit settings can add `model_selection:{model:{provider,id},thinking_level}`.
These are verified native values after selection, not requested values or a
binding for every later provider call. There is no requested/scope/status/actual
wrapper. If selection fails or times out before verification, the field is omitted.
A later prompt failure may retain values already verified before its dispatch.

## Prompt settings timeout

`timeout_ms` (50–30000, default 5000) bounds native ACKs, not model execution. A timed-out setter fences further input until its exact ACK arrives. Late ACKs release native admission fences and validate session identity; they never apply another setting or send the pending prompt.

A timed-out model step can leave thinking unapplied. The response remains unknown;
there is no late-result lookup. Create retains its child identity and nested send
result when it can return them.

After an unknown result, inspect `list.status` for current settings and
authorized `read` for native history. Do not automatically resubmit:
another call is a new operation and can duplicate input or create another child.

## Manual compaction: `compact`

```json
{
  "session_id": "ps_…",
  "instructions": "Preserve decisions and open questions"
}
```

`compact` uses native RPC, companion `ctx.compact` completion/error callbacks, or a host compact callback. By default it requires proven-idle admission and `send`, not `read` or `stop`. Owned RPC can prove this through its observer and ACKs. Ordinary companions and supplied SDK/RPC bindings cannot attest unrelated preflight: they return `COMPACT_BUSY` for observed busy work or `COMPACT_IDLE_UNCONFIRMED` otherwise, without aborting. Hosts with their own admission gate may implement idle compact. An omitted host callback returns `COMPACT_UNSUPPORTED`.

**Interrupting.** Explicit `interrupt:true` additionally requires `stop` and invokes native abort-before-compaction. This **can interrupt the agent even if summarization then fails**. It is not stop-all and does not withdraw queued messages. To cancel a compaction in progress, use native local cancellation or separately authorized `stop` where the owner supports it. Ordinary companion stop-all remains unsupported.

**Result.** An accepted control result means native compaction completed. It contains only bounded metadata: `first_kept_entry_id`, `tokens_before` and `estimated_tokens_after` (the estimate may be null). Token fields describe only the compaction result. Summary text and native details are not exposed through `send` permission; use `read` for the resulting native summary.

**Parameters and timeout.** `instructions` is optional, at most 100000
UTF-16 units. `timeout_ms` is 50–30000 (default 5000), not an abort deadline.
Late ACKs settle private state without repeating compaction. Attached operations continue after transport timeout and retain their input fence until the native callback/controller Promise settles. The ordinary RPC client exposes native rejection and lost ACK as plain Errors; that binding reports `HOST_COMPACT_UNCERTAIN` rather than guessing from error text. SDK and companion callbacks can report definitive native failure. There is no
`recover` parameter or result lookup; use `list/read` after an unknown result.
Native extension cancellation returns a refusal.

## Native settings refresh

Cold starts load the current native on-disk settings, providers and extensions
using the owner's launch profile. Explicit launch overrides still apply.

Ordinary TUI owners can use local `/reload`; the companion closes its old
endpoint and registers a fresh generation at session-start, retaining the
writer claim through the transition. Cooperative RPC and SDK hosts control
their own native reload/close lifecycle.

### Host compact callback

An optional `compact({instructions?, interrupt?, sessionFile, sessionId, beforeDispatch})` callback must use the existing native writer, enforce its own idle admission when interrupt is false, and resolve with the native compaction result only at completion. Call `beforeDispatch()` immediately before native dispatch. The adapter drains admitted compaction during release and blocks overlapping compaction/input until settlement. Native summary/details never enter the public control receipt. Bridge, companion and host components use the same current contract.
