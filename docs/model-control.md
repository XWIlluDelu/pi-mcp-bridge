# Model discovery and native controls

Model discovery is independent of sessions. Standalone selection, prompt settings and compaction act on sessions:

| Operation                | Behavior                                       | Owner                                                    | Permission                                 |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| `models`                 | Native configured model catalog                | No session owner involved                                | Effective execution authorization          |
| `set_model`              | Change current selection, including while busy | Native setters on owned RPC, companion or supported host | `send`                                     |
| `send`/`create` settings | Apply model/thinking, then submit input        | Proven-idle Bridge-owned RPC                             | `send` / `create`                          |
| `compact`                | Native context compaction                      | Owned RPC idle; attached explicit interrupt              | `send`; `interrupt:true` also needs `stop` |

## Session-independent model catalog

```json
{ "offset": 0, "limit": 30 }
```

`models` accepts only pagination. The request's permission snapshot must allow effective `send`, `command` or `create` on a configured project, or `send`/`command` on an existing in-scope native session. Configured folders are creation targets, not a restriction on native session projects. When no configured project qualifies, the Bridge can discover canonical session identity metadata and apply the ordinary default/project/session override priority; it does not parse transcripts or contact owners. No list/read right is required. The catalog remains independent of session selection and grants no session operation.

A short-lived helper uses native `ModelRuntime.create({allowModelNetwork:false})` with the owner's existing launch-profile agent directory and inherited environment. It inherits the trusted Bridge process cwd, not a project/session cwd. It reads the native catalog from that agent's model/provider/auth configuration and locally cached catalog data, without network refresh or model calls. It does not create, find, read, observe or start a session, or load resource/extension factories. The caller cannot choose an agent directory, project or environment.

**User Pi, read-only storage.** The helper loads `ModelRuntime`, thinking capabilities and native credential parsing from the same user installation selected for CLI execution. `model-catalog-storage.mjs` loads that installation's exported `ReadOnlyAuthStorage` from `./core/auth-storage.js` (not re-exported at the SDK root). A small read-only `ModelsStore` adapter passes existing JSON cache entries to native `ModelRuntime` without copying its model schema or pinning a provider-entry version. Both stores reject mutations: discovery never initializes auth/cache files, locks them, changes permissions or writes credentials. Missing native modules or loading failures report an unavailable catalog; Bridge never substitutes its own Pi.

This catalog works even when there are no sessions. It excludes models registered only by extensions or a session at runtime; it is not a live owner's complete catalog. Native loading failures return `MODEL_CATALOG_UNAVAILABLE`, without underlying error text.

The response contains only `models` and `next_offset` (null at the end). Offset defaults to 0; limit is 1–100, default 30. Models are sorted by provider/ID; pagination does not freeze the catalog across calls. Each item contains only `provider`, `id`, `name`, `input`, native `thinking_levels`, `context_window`, `max_output_tokens` and `input_limits`. Missing metadata is null. Credentials, endpoints, headers, provider configuration and raw provider errors are omitted.

To inspect a session's current settings, use `list({session_id})`: `status.model` is `{provider,id}` or null, and `status.thinking_level` is a native level or null. These are live owner observations under list permission, not catalog data or guesses from saved history. See [list status](api.md#list).

## Standalone selection: `set_model`

```json
{
  "session_id": "ps_…",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Input is only `session_id` plus `model` and/or `thinking_level`; at least one
setting is required. It needs the target's existing `send` permission, using
the receive-time permission snapshot. New calls reauthorize; identity and
ownership checks remain live throughout an admitted call.

Success returns only the actual selection:

```json
{
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Pi applies model-switch thinking preferences and clamps an explicit thinking
level to the target's native capabilities. Both returned fields reflect the
result, including automatic adjustment. The tool changes session state without
a prompt, abort, queue withdrawal or global-default persistence. Thinking-only
calls apply to the execution-time current model; they do not resolve or restore
an earlier model observation.

Busy sessions are supported. A provider request already issued keeps its
captured selection; later provider calls, including calls later in the same
run or from queued input, use the then-current selection. Bridge serializes
its own same-session mutations, not independent native owner actions.
Unresolved prompt preflight and concurrent Stop do not block standalone selection.
An unresolved native setter rejects overlapping settings and prompt admission
until it finishes. A later step can fail after the model has changed; there
is no rollback.

Bridge-owned RPC uses native `set_model` / `set_thinking_level`. Updated ordinary
TUI/RPC companions use public extension setters. Supplied SDK/RPC host bindings
use their public native setters; custom hosts may supply the optional
[`setModel` callback](runtime.md#host-model-setter).
Current owners without a setter callback return `MODEL_SELECTION_UNSUPPORTED`; they
are not restarted to add the feature.

For a saved session with no live owner, the existing mutation path validates
the saved session and cwd and cold-resumes a native Bridge-owned RPC. A runtime
started for this setter becomes eligible for the existing safe idle release,
including after failure. Existing external owners remain open. Native launch
overrides still apply on each cold start. Read-only `list` and `models` never
start a session runtime.

There is no tool timeout parameter. The existing native/IPC acknowledgement
budget is 5 seconds per request. Lost or late confirmation is a tool error
with `uncertain:true`; already-dispatched settings may have taken effect.
Late ACK handling validates identity and clears the native fence, without
applying another setting or sending input. Inspect `list.status` and authorized
`read` before deciding whether another call is appropriate. HTTP/stdio never
automatically replay it.

### Empty-context resume limitation

Verified in Pi 1.3.0 and 1.4.0: native startup restores saved model/thinking only when the current branch already
produces context messages. A published session whose first input was handled
without a run, or refused before dispatch, can have no such messages. In that
case a successful `set_model` writes native selection entries, but after normal
release the next cold resume still chooses native defaults instead of restoring
them. A session with context messages follows the normal restoration path.

This is a Pi SDK/CLI startup limitation, not a missing Bridge write. Bridge
retains normal automatic release and does not insert messages, keep a separate
preference store or turn saved selections into launch overrides. Correcting
startup semantics requires a native Pi fix and validation of the actual CLI;
the fix must be present in the user's actual Pi installation.

## Prompt model and thinking settings

```json
{
  "session_id": "ps_…",
  "text": "Review the change",
  "model": { "provider": "provider-id", "id": "model-id" },
  "thinking_level": "high"
}
```

Both `send` and `create` accept `model` and/or `thinking_level`, including create's first prompt. Settings require text or images. They share the prompt's session lane. Unlike standalone `set_model`, these convenience parameters retain their proven-idle submission rules.

- Model only: Pi selects the model and preserves or adjusts thinking natively. The result reports the verified effective model and thinking level.
- Thinking only: validate against the current native model and change its level.
- Both: validate the requested level against the target model before changing either.
- Neither: keep native session behavior. A cold start normally restores saved selection, subject to explicit launch overrides, model availability and the [native empty-context limitation](#empty-context-resume-limitation).

Levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, restricted to the native target's supported set. Unsupported explicit levels return `THINKING_LEVEL_UNSUPPORTED`; unknown reasoning support returns `THINKING_SUPPORT_UNKNOWN`. Global user defaults are unchanged.

Explicit settings require a proven-idle Bridge-owned RPC with no pending input. Busy returns `MODEL_SELECTION_BUSY`; `idle_only` skips busy work without changing settings. Unproven idle returns `MODEL_SELECTION_IDLE_UNCONFIRMED`. Shared hosts and companions return `MODEL_SELECTION_UNSUPPORTED` before settings or input dispatch. Plain queued sends continue to use native settings when consumed. Immediately
before prompt dispatch, explicit settings are checked against the current native
selection. Image interpretation stays with native input extensions and the final
Pi/provider path, as described in [image input](api.md#image-input-send-and-create). A conflicting local change refuses the prompt;
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
