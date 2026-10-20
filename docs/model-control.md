# Model discovery and native controls

These operations use the same session IDs, owner registry and durable request journal as `send` and `create`. Their scopes and permissions differ:

| Operation                    | What it does                                               | Applies to                         | Permission                                 |
| ---------------------------- | ---------------------------------------------------------- | ---------------------------------- | ------------------------------------------ |
| `set_model`                  | Changes the persistent session model and/or thinking level | Session-wide; allowed while busy   | `send`                                     |
| `send`/`create` with `model` | Selects a model, then submits that prompt                  | Bridge-owned RPC proven idle       | `send` / `create`                          |
| `compact`                    | Compacts context; summaries are readable only with `read`  | Bridge-owned RPC; idle by default  | `send`; `interrupt:true` also needs `stop` |
| `reload`                     | Normal-EOF close and reopen of the same session            | Live Bridge-owned RPC, proven idle | `send`                                     |

`models` (discovery) also requires `send`; compaction summaries require `read`.

## Runtime model discovery

```json
{ "session_id": "ps_…", "offset": 0, "limit": 30 }
```

Call `models` for an authorized, known session. A connected owner returns its native available-model snapshot (`ModelRuntime.getAvailableSnapshot()`, RPC `get_available_models`, or the companion's `modelRegistry.getAvailable()`). Availability reflects Pi's configured/runtime-auth snapshot; discovery does not probe provider endpoints.

An inactive saved session returns `source:"inactive"`, `availability:"unknown"`, `current:null`, `models:null`. Supply `start:true` to start its native RPC **without a prompt**. A live incompatible owner returns `MODELS_UNSUPPORTED`; the existing writer remains in place.

An active response has `source:"runtime"`, `availability:"native_snapshot"`, `current`, `models`, `total` and `next_offset`. `offset` defaults to 0; `limit` is 1–100 (default 30). Pages are sorted by provider/ID and are not a frozen catalog.

Each model exposes only:

- `provider`, `id` and the native display `name`.
- `input` modalities and `supports_images`.
- `context_window` and `max_output_tokens`, in tokens.
- `reasoning` and `thinking_levels` from Pi's native helper. A non-reasoning model exposes `["off"]`.
- Native `input_limits` (`max_request_bytes`, `images_per_message`, `images_per_request`) when the model provides them.

`current` also includes the actual `thinking_level`. Missing metadata is `null`, not false or zero. Responses omit provider configuration, credentials, raw provider errors and inferred pricing. Owners must advertise these capabilities. `model_selection` is `session`, `unsupported` or `unknown`; `prompt_model_selection` is `idle_only_session`, `unsupported` or `unknown`.

## Session model and thinking: `set_model`

```json
{
  "session_id": "ps_…",
  "request_id": "settings-1",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

`set_model` accepts model only, thinking only, or both. It changes **persistent session state** through native Pi APIs and history. It is not a one-prompt binding and does not change the user's global defaults.

**Validation.** The Bridge checks the target against the native available snapshot. Explicit thinking must be a level the target supports; otherwise `THINKING_LEVEL_UNSUPPORTED` rejects the request before the model changes. Missing native reasoning metadata yields `THINKING_SUPPORT_UNKNOWN`. Explicit thinking requests are validated rather than clamped.

**Model-only changes** keep Pi's native level selection and clamping. The receipt reports the effective `model`, `thinking_level` and `thinking_adjustment`: `none`, `native_adjustment`, or `unknown` when a late result cannot attribute the adjustment. Native adjustment can mean switching to `off` on a non-reasoning target or choosing the model's native default.

**Busy sessions.** Switching while busy is supported:

1. A provider request already issued keeps its captured model and thinking.
2. The next agent-loop provider call, including a continuation after tool execution, uses the session selection then in effect.
3. Queued steer/follow-up messages have **no per-message model binding**; their later calls use the selection then in effect.

Bridge calls share the session's mutation lane and do not change other sessions. SDK/RPC host bindings and the companion support standalone selection, but an independently controlled native UI can later choose another model.

**Timeout and recovery.** `timeout_ms` is 50–30000 (default 5000) and is the ACK budget. To recover, repeat the same `request_id` and omit **both** `model` and `thinking_level`; both fields are fingerprinted. A timeout fences later owned input until the exact late ACK arrives.

A cooperative RPC binding blocks new input only while a native setter is
unconfirmed. No-op validation failures and failed state reads after a confirmed
setter do not leave that block in place. Pi 1.3's `RpcClient` does not distinguish a
negative ACK from a timeout in its public error type; an actual setter failure
therefore remains uncertain. The owning application must resolve that operation
or retire the old RPC before replacing the binding; a later state read alone is
not proof that a timed-out setter has finished.

**Partial outcomes.** Model and thinking changes are separate native steps, not a rollback transaction. An uncertain or failed later step can leave the earlier model change in place. If the model step completes late before an explicit thinking step ran, the receipt reports `MODEL_SELECTED_THINKING_NOT_SET` with the observed selection, and the remaining step is never executed afterward.

## Model plus a prompt: `send` and `create`

`send` and `create` accept `model:{"provider":"…","id":"…"}`. The model is selected immediately before the new prompt is submitted, in the same session lane, and stays the session selection afterward. Model-only selection may adjust thinking natively, as described above. Set explicit thinking with `set_model`.

This combination requires a Bridge-owned, proven-idle RPC with no queued or unacknowledged input:

- Busy: `MODEL_SELECTION_BUSY`. With `idle_only`, busy input is skipped without changing the model.
- Idle not proven: `MODEL_SELECTION_IDLE_UNCONFIRMED`.
- Shared host or companion: `MODEL_SELECTION_UNSUPPORTED`, returned **before any selection or submission**.

Pi's steer/follow-up queues have no per-item model-selection hook. Switching at enqueue time would affect the run in progress, so queued prompts use the session selection in effect when consumed.

Receipts include `model_selection.requested`, `scope:"session"` and `status` (`not_changed`, `selected`, `unknown`). A failure after selection does not roll it back. A late model ACK can record `MODEL_SELECTED_PROMPT_NOT_SENT`, and the prompt is never sent afterward. `create` keeps its created child identity and nested send outcome even if selection or admission fails.

Recovery never creates another child, reverts the model or sends again. Changing the model under an existing request ID is a conflict. To recover `send` or `create`, omit `model`, text and images.

## Manual compaction: `compact`

```json
{
  "session_id": "ps_…",
  "request_id": "compact-1",
  "instructions": "Preserve decisions and open questions"
}
```

`compact` supports Bridge-owned RPC only; other owners return `COMPACT_UNSUPPORTED`. By default it requires a proven-idle session and needs `send`, not `read` or `stop`. Busy or unconfirmed states reject without aborting anything.

**Interrupting.** Explicit `interrupt:true` additionally requires `stop` and invokes native abort-before-compaction. This **can interrupt the agent even if summarization then fails**. It is not stop-all and does not withdraw queued messages. To cancel a compaction in progress, use the separately authorized native `stop`.

**Receipts.** An accepted receipt means native compaction completed. It contains only bounded metadata: `first_kept_entry_id`, `tokens_before` and `estimated_tokens_after` (the estimate may be null). Token fields describe only the compaction result. Summary text and native details are not exposed through `send` permission; use `read` for the resulting native summary.

**Parameters and recovery.** `instructions` is optional, at most 100000 UTF-16 units. `timeout_ms` is 50–30000 (default 5000) and is not an abort deadline. Recover with `{"session_id":"ps_…","request_id":"compact-1","recover":true}`; recovering an interrupting receipt still requires `stop`. Late ACKs update receipts without repeating compaction. Native extension cancellation returns a refusal.

## Reload: normal-EOF RPC reopen

```json
{ "session_id": "ps_…", "request_id": "reload-1", "timeout_ms": 5000 }
```

`reload` supports only a live **Bridge-owned RPC**, using `method:"rpc_reopen"`. It is a normal-EOF cold reopen, **not** `AgentSession.reload()`, slash forwarding, a Bridge-service restart or a tunnel restart.

**Sequence.** The Bridge fences mutations, proves native idle from ACK, queue, settlement and owner observations, drains late receipt writes, and waits for the exact child's normal exit. Only then does it reopen the same saved session. The session ID, file and committed context stay the same; process identity and generation change.

**What is reapplied.** The reopen reapplies the Bridge's launch profile and the native on-disk settings, providers and extensions. The saved model and thinking selection are restored unless an explicit launch override or changed availability replaces them; the receipt always reports the final effective `model` and `thinking_level`. Edits to the Bridge owner launch configuration itself are not reread; they need a Bridge service reload or restart.

**Permissions and errors.** Only `send` is needed. Reload performs no implicit stop, abort, queue withdrawal, signal or forced-exit timer. Busy, unproven-idle and saved-only sessions return `RELOAD_BUSY`, `RELOAD_IDLE_UNCONFIRMED` and `RELOAD_NOT_RUNNING` respectively. Other owners return `RELOAD_UNSUPPORTED`.

**Receipt and recovery.** The durable receipt lives in the **Bridge**, not in the child being closed. It records `previous_generation`, the new `generation` when known, and `phase` (`exiting`, `reopening`, `completed`). `timeout_ms` is 50–30000 (default 5000); on timeout the result is unknown while fenced work continues. The timeout does not kill the child. Repeat the same `request_id` to observe the saved phase and outcome. Startup failure, shutdown interruption or lost confirmation never trigger another automatic reopen. After an unknown result, observe the owner and receipt before a new explicit action; do not assume the operation did nothing.

### Other access paths and lifecycle

- **Ordinary TUI:** the human/native owner invokes local `/reload`. The companion's old `session_shutdown(reason:"reload")` marks the owner transitioning and closes its IPC. The fresh `session_start` registers a new generation for the same process and session. A gap or failure blocks remote fallback and never authorizes a second writer. A call in flight on the disappearing endpoint is unknown, not proof that the reload succeeded.
- **Cooperative RPC:** the original pipe owner controls native lifecycle. Pi has no RPC reload command; the pipe owner must manage the process lifecycle.
- **SDK hosts:** native `AgentSession.reload()` invalidates the old extension runner and reloads settings, resources and tools before session-start. It also resets a process-global provider registry. A generic remote wrapper could lose its own channel or alter other SDK sessions, so the supplied binding does not advertise remote reload. The owning application must coordinate it.

Native lifecycle sources: Pi 1.3 `AgentSession.reload()`, the RPC command dispatcher, and this repository's companion `session_shutdown`/`session_start` handlers.
