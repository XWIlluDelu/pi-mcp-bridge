# Model discovery and native controls

Use `models` to discover choices, `list` for the live selection, and `set_model`
to change it without submitting input. See [owner capabilities](runtime.md#runtime-capabilities).

## Session-independent model catalog

```json
{ "offset": 0, "limit": 30 }
```

Requires `send`, `command` or `create` on a configured project, or `send` or
`command` on an in-scope session. The native helper reads the owner's launch
environment and stored provider/auth configuration without loading sessions or
extensions, altering credentials or refreshing over the network. Live
extension-only models can still be available to a running owner.

`{models,next_offset}` sorts by provider and ID. Offset defaults to 0 and
limit to 30 (range 1–100). Rows expose `provider`, `id`, `name`, `input`,
`context_window` and `thinking_levels`. Missing metadata is null. Pages reflect
the catalog at request time. A helper failure returns `MODEL_CATALOG_UNAVAILABLE`
with `catalog_stage` and `catalog_reason` in [diagnostics](configuration.md#diagnostics).

## Standalone selection: `set_model`

```json
{
  "session_id": "ps_…",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Requires `send` and at least one setting. Success returns the actual selection:

```json
{
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

A model-only change preserves the effort current immediately before the switch, overriding target-model and global switch defaults. Pi's native thinking setter applies its compatible fallback if the new model does not support that effort. Explicit thinking also uses native clamping. An explicit available model can initialize a session with no current model.
Thinking-only calls require a current model and act on it at execution. Selection changes session state without sending input, aborting work or changing global defaults.

Busy selection is supported. Issued provider requests keep their captured settings; later provider calls, including continuations and queued input, use the current selection. Bridge serializes its own same-session mutations while independent native actions remain possible. Prompt preflight and concurrent Stop do not block selection. An unresolved setter blocks overlapping settings/input until it settles. Partial changes are not rolled back.

Without a live owner, Bridge cold-resumes the saved session. Empty contexts
restore recorded model/thinking choices from the saved branch if available.
Explicit native launch overrides take precedence.

An ACK timeout can leave a partial change. Owned RPCs track late ACKs and
attached setters stay fenced until the native call settles. Inspect
`list.status` before trying another selection.

## Prompt model and thinking settings

```json
{
  "session_id": "ps_…",
  "text": "Review the change",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Send and create accept either setting, including create's first prompt, together with required text or images:

- Model only: preserve current effort, using Pi's native compatible fallback if unsupported by the new model.
- Thinking only: validate and set the level on the current model.
- Both: validate thinking against the target model before either change.
- Neither: use the owner's selection, including cold-start restoration, launch overrides and model availability.

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, restricted
to the target's supported set. Unsupported explicit levels return
`THINKING_LEVEL_UNSUPPORTED`; unknown support returns `THINKING_SUPPORT_UNKNOWN`.
This prompt-specific validation differs from standalone `set_model`, which
returns Pi's actual selection after native clamping.

On a Bridge-owned RPC, explicit prompt settings require a proven-idle session with no pending input (busy work returns `MODEL_SELECTION_BUSY`, `idle_only` skips without changes, unconfirmed idle returns `MODEL_SELECTION_IDLE_UNCONFIRMED`). On companions and hosts with `set_model` support, Bridge applies standalone model selection first and then submits the prompt (hosts without `set_model` return `MODEL_SELECTION_UNSUPPORTED`). Plain queued sends use native settings when consumed.

Settings and input are separate native commands. Bridge rechecks identity, admission and selected values before dispatch; it refuses a conflicting local change instead of restoring earlier settings. Settings-bearing input omits native queue behavior, so a hook starting concurrent work causes refusal. Pi offers no atomic settings-plus-input transaction or per-message settings binding: an earlier setting can remain after a later failure. Native image processing follows the [send/create image contract](api.md#image-input-send-and-create).

Explicit settings add `model_selection:{model:{provider,id},thinking_level}` only after native verification. These values may accompany a later prompt failure; they do not bind later provider calls. Global defaults are unchanged.

### Prompt settings timeout

A timed-out setter fences further input until its ACK and identity are checked.
The pending prompt is never submitted later. Inspect `list.status` and history
for any partial change.

## Manual compaction: `compact`

```json
{
  "session_id": "ps_…",
  "instructions": "Preserve decisions and open questions"
}
```

Default compaction requires `send` and proven idle. Owned RPCs, ordinary companions
and SDK bindings installed before local input can establish idle admission. The
owner-side gate checks native idle, queued messages and public operation
lifetimes (including asynchronous input preparation and bash), then excludes new
local work until native compaction settles. Owned RPC uses its matching observer
for this atomic admission; a parent-side idle sample alone cannot authorize
non-interrupting compaction. Input-free model selection remains available.
Busy work returns `COMPACT_BUSY`.
The supplied RPC binding has no gate over its remote writer and still requires
explicit interrupt: it reports `COMPACT_BUSY` for observed busy work or
`COMPACT_IDLE_UNCONFIRMED` otherwise. Custom hosts may supply their own atomic
gate; a missing callback returns `COMPACT_UNSUPPORTED`.

Explicit `interrupt:true` additionally requires `stop` and invokes native abort-before-compaction. The agent may be interrupted even if summarization fails. This does not withdraw queued messages. Use native cancellation or a separate stop where supported to cancel ongoing compaction; ordinary companions do not support remote stop-all.

`status:"completed"` confirms that native compaction finished. The result includes `first_kept_entry_id`, `tokens_before` and nullable `estimated_tokens_after`; read permission is required for the native summary. Optional instructions are at most 100000 UTF-16 units. If the five-second acknowledgement budget expires after dispatch, the result is `status:"unknown"` with `reason:"ACK_TIMEOUT"`. Native compaction can finish after the caller stops waiting. Attached operations retain their input fence until the native callback or controller Promise settles.

The supplied RPC binding reports `HOST_COMPACT_UNCERTAIN` when its plain native Error cannot distinguish rejection from a lost acknowledgement. SDK and companion callbacks can report definite failure. After an unknown result, inspect list/read; a new call performs another compaction.

For owned RPC, a `PI_REJECTED` result may include one of three allowlisted `native_reason` values: `Nothing to compact (session too small)`, `Already compacted`, or `Compaction cancelled`. Other native/provider/extension messages are omitted. Small sessions can be refused before the compaction hook because Pi retains a configured recent-token window and needs older content to summarize.

Host implementers should follow the [compact callback contract](runtime.md#host-compact-callback).
