# Model discovery and native controls

Use `models` to discover configured choices, `list` to inspect a live session's
current selection, and `set_model` to change that selection without sending work.
Settings on `send` or `create` instead apply immediately before that call's input
and have stricter idle and validation requirements. [Runtime capabilities](runtime.md#runtime-capabilities)
describe which owner types support each operation.

| Operation                | Purpose                                        | Owner support                                                | Permission                             |
| ------------------------ | ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------------- |
| `models`                 | Native configured catalog                      | No session owner needed                                      | Effective execution authorization      |
| `set_model`              | Change current selection, including while busy | Owned RPC, companion or supported host                       | `send`                                 |
| `send`/`create` settings | Apply settings before input                    | Proven-idle Bridge-owned RPC                                 | `send` / `create`                      |
| `compact`                | Native context compaction                      | Owned RPC, companion/SDK idle gate; other hosts as supported | `send`; interrupt also requires `stop` |

## Session-independent model catalog

```json
{ "offset": 0, "limit": 30 }
```

Authorization requires effective `send`, `command` or `create` on a configured project, or `send`/`command` on an existing in-scope session, with normal default/project/session override priority. Native session projects need not be configured creation targets. List/read permission is not required; authorization may inspect session identity metadata without reading transcripts or contacting owners.

The catalog uses the same user Pi installation as CLI execution. A short-lived native `ModelRuntime` helper reads the owner's launch-profile agent directory, inherited environment and existing model/provider/auth configuration and caches. It uses the trusted Bridge cwd, disables network refresh and loads no session, resource or extension factories. Credential and cache stores are read-only, including when files are missing. Callers cannot select a different environment.

Discovery works without saved sessions, but excludes models registered only by extensions or live sessions. Pi installation and launch-profile errors retain their own codes; see [native environment](configuration.md#native-environment). Failures running or decoding the catalog helper return `MODEL_CATALOG_UNAVAILABLE`; [Bridge diagnostics](configuration.md#diagnostics) record `catalog_stage` and `catalog_reason` to identify the failing stage without exposing credentials or provider configuration.

An absent catalog entry therefore does not establish that a model is unavailable
to an already-running owner. Standalone selection resolves the requested model
against that owner's available models. The catalog also performs no provider
request, so it does not verify network access or successful generation.

The response is `{models,next_offset}`, with null at the end. Offset defaults to 0; limit is 1–100, default 30. Items sort by provider/ID and contain only `provider`, `id`, `name`, `input`, `context_window` and `thinking_levels`. `thinking_levels` lists Pi's supported thinking levels (`["off"]` for a model without reasoning). Missing metadata is null. Pages are not frozen across calls. Credentials, endpoints and provider configuration are excluded.

For a live session's actual selection, use [list status](api.md#list): `status.model` and `status.thinking_level` come from its owner and are null when unobserved.

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

Owned RPCs, ordinary TUI/RPC companions and supplied SDK/RPC bindings support native setters. Custom hosts use the optional [setModel callback](runtime.md#host-model-setter); a missing callback returns `MODEL_SELECTION_UNSUPPORTED`. Without a live owner, Bridge validates the saved session/cwd and cold-resumes an owned RPC, which becomes eligible for normal idle release, including after failure. Native launch overrides apply at each cold start.

The acknowledgement budget is five seconds per native/IPC request; there is no
tool timeout parameter. A lost or late confirmation produces `uncertain:true`
and the setting may already have changed. Owned RPCs retain matching late-ACK
tracking; attached setters stay fenced until their native call settles. Neither
path retries the selection. Inspect `list.status` and authorized read before
another call.

### Empty-context resume limitation

In tested Pi 1.3.0 and 1.4.0, startup restores saved model/thinking only when the current branch produces context messages. A session whose first input was handled without a run or refused before dispatch can remain empty: `set_model` writes selection entries, but its next cold resume selects native defaults. Bridge retains normal idle release; restoring those entries requires a fix in the selected Pi installation.

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
- Neither: follow native selection, including cold-start restoration, launch overrides, availability and the [empty-context limitation](#empty-context-resume-limitation).

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh` and `max`, restricted
to the target's supported set. Unsupported explicit levels return
`THINKING_LEVEL_UNSUPPORTED`; unknown support returns `THINKING_SUPPORT_UNKNOWN`.
This prompt-specific validation differs from standalone `set_model`, which
returns Pi's actual selection after native clamping.

Explicit prompt settings require a proven-idle Bridge-owned RPC with no pending input. Busy work returns `MODEL_SELECTION_BUSY` (`idle_only` skips without changes), unconfirmed idle returns `MODEL_SELECTION_IDLE_UNCONFIRMED`, and companions/shared hosts return `MODEL_SELECTION_UNSUPPORTED`. Plain queued sends use native settings when consumed.

Settings and input are separate native commands. Bridge rechecks identity, admission and selected values before dispatch; it refuses a conflicting local change instead of restoring earlier settings. Settings-bearing input omits native queue behavior, so a hook starting concurrent work causes refusal. Pi offers no atomic settings-plus-input transaction or per-message settings binding: an earlier setting can remain after a later failure. Native image processing follows the [send/create image contract](api.md#image-input-send-and-create).

Explicit settings add `model_selection:{model:{provider,id},thinking_level}` only after native verification. These values may accompany a later prompt failure; they do not bind later provider calls. Global defaults are unchanged.

## Prompt settings timeout

Native requests retain their internal five-second acknowledgement budget; there is no tool timeout parameter. A timed-out setter blocks further input until its acknowledgement arrives and identity is validated. It never causes the pending prompt or another setting to be dispatched later.

A model step can succeed while thinking remains unapplied. The result stays unknown; inspect `list.status` and native history before another call. Create retains its chosen child ID and nested send result when available. Every new call can submit input or create another child.

## Manual compaction: `compact`

```json
{
  "session_id": "ps_…",
  "instructions": "Preserve decisions and open questions"
}
```

Default compaction requires `send` and proven idle. Owned RPCs, ordinary companions
and SDK bindings installed before local input can establish idle admission. The
companion/SDK gate checks native idle, queued messages and public operation
lifetimes (including asynchronous input preparation and bash), then excludes new
local work until native compaction settles. Busy work returns `COMPACT_BUSY`.
The supplied RPC binding has no gate over its remote writer and still requires
explicit interrupt: it reports `COMPACT_BUSY` for observed busy work or
`COMPACT_IDLE_UNCONFIRMED` otherwise. Custom hosts may supply their own atomic
gate; a missing callback returns `COMPACT_UNSUPPORTED`.

Explicit `interrupt:true` additionally requires `stop` and invokes native abort-before-compaction. The agent may be interrupted even if summarization fails. This does not withdraw queued messages. Use native cancellation or a separate stop where supported to cancel ongoing compaction; ordinary companions do not support remote stop-all.

`status:"completed"` confirms that native compaction finished. The result includes `first_kept_entry_id`, `tokens_before` and nullable `estimated_tokens_after`; read permission is required for the native summary. Optional instructions are at most 100000 UTF-16 units. The internal five-second acknowledgement budget does not abort compaction; an expired wait returns an unknown outcome, and native history can show a later completed summary. Attached operations retain their input fence until the native callback or controller Promise settles.

The supplied RPC binding reports `HOST_COMPACT_UNCERTAIN` when its plain native Error cannot distinguish rejection from a lost acknowledgement. SDK and companion callbacks can report definite failure. After an unknown result, inspect list/read; a new call performs another compaction.

For owned RPC, a `PI_REJECTED` result may include one of three allowlisted `native_reason` values: `Nothing to compact (session too small)`, `Already compacted`, or `Compaction cancelled`. Other native/provider/extension messages are omitted. Small sessions can be refused before the compaction hook because Pi retains a configured recent-token window and needs older content to summarize.

Host implementers should follow the [compact callback contract](runtime.md#host-compact-callback).

## Native settings refresh

Cold starts load current on-disk settings, providers and extensions under the owner's launch profile and explicit overrides. [`reload({session_id})`](api.md#reload) refreshes a supported idle owner without sending a task. The companion retains its writer claim while replacing its endpoint. Unsupported owners require native `/reload` or a host-managed reopen; see the [reload lifecycle](runtime.md#remote-reload).
