# Public tool API

Inputs are strict objects defined by `src/tool-schemas.mjs`. Examples below are tool arguments, not JSON-RPC envelopes. Each request uses its [receive-time permission snapshot](configuration.md#request-permission-snapshots); ownership and execution checks remain live.

## Sessions and mutations

A `session_id` is an opaque Bridge ID derived from the canonical native file path and native session identity. It survives restart but can change when that identity moves or is replaced. List permission controls discovery; a known ID remains usable with the permission for the requested operation.

Every mutation call is a new operation, including identical calls. There is no mutation-ID deduplication or result lookup. If a result is lost or unknown, inspect `list` for session activity and `read` for native history before deciding whether to submit again. Retain a returned child `session_id` even if create's initial send failed.

| Status     | Meaning                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `started`  | Pi started a send/create prompt; model execution may still be running.         |
| `queued`   | Pi queued a send/create prompt.                                                |
| `handled`  | Native input handling completed, such as an extension command.                 |
| `accepted` | A command, stop or compact operation returned its native result.               |
| `rejected` | Definite refusal, explained by `reason`.                                       |
| `skipped`  | Not submitted, such as idle-only finding busy work or stop finding no runtime. |
| `unknown`  | Dispatch or outcome is uncertain.                                              |
| `deleted`  | The session moved to recoverable Bridge trash.                                 |

Tool errors return `isError:true` with `{error:{code:…}}` in text and structured content. An operation may instead return `rejected` or `unknown`. Batch retains each item's result or error independently.

### List

```json
{ "project": "analysis", "name": "review", "active_after": "2026-10-01T00:00:00Z", "limit": 30 }
```

Filters combine with AND: case-insensitive project-directory/name substrings, inclusive RFC3339 activity bounds and exact `session_id`. Offset defaults to 0; limit is 1–100, default 30. Results sort by newest native file mtime, then session ID. `next_offset` is null at the end; concurrent activity can reorder later pages.

Each row contains `session_id`, `project`, nullable `name` and `parent_session_id`, `last_activity` and `status`. A parent ID is disclosed only with its own list permission. Listing requires no read permission and never starts Pi.

Status describes the sampled runtime:

| State         | Meaning                                                   |
| ------------- | --------------------------------------------------------- |
| `saved`       | No cooperating live runtime found.                        |
| `busy`        | Activity, input preparation or pending work observed.     |
| `idle`        | Explicit idle evidence with no conflicting busy evidence. |
| `unknown`     | Connected, but insufficient evidence to establish idle.   |
| `unavailable` | Ownership/state could not be safely observed.             |

Status includes observation time, pending-message count where available, and live `model:{provider,id}` / `thinking_level` values or null. Saved and unavailable sessions have null settings. These observations describe session activity, not completion of a particular prompt.

Connected runtimes also expose `capabilities:{send,command,stop}`. Values are true, false or null for supported, unsupported or unconfirmed operation paths. Capabilities are independent of grants and current admission state; see the [owner capability table](runtime.md#runtime-capabilities).

`creatable_projects` lists configured destinations with project-level `list` and `create` permission, in configuration order. It includes empty projects and is independent of session filters, pagination and session-specific grants. A known configured destination remains usable with create permission even if it is hidden from this catalog.

### Read

```json
{ "session_id": "ps_…", "max_bytes": 24000 }
```

Read uses a matching configured session reader, otherwise native projection. Explicit `view:"native"` selects native projection; `preset`, `select` and `leaf_id` customize the selected reader. Adapted results identify `reader.id`. `view:"observed"` reads captured request-stage context and accepts only `session_id`, `view`, `cursor` and `max_bytes`. Missing observations are unavailable; reading never starts Pi.

Native `preset:"latest"` selects the last prompt, assistant text and sampled thinking. `recent` adds summaries and the last three prompts; `full` selects all effective context. Selectors add or sample system instructions, tools and commands. See [reading](reading.md) for routing, selectors, content and budgets.

Pages start with the newest selected content. Continue backwards with `cursor` alone, optionally changing `max_bytes`. Session, view, selection and leaf stay frozen; conflicting overrides, eviction or restart return `STALE_CURSOR`. Every continuation reauthorizes read.

### Models

`models({offset?,limit?})` returns `{models,next_offset}` from the owner's native configured catalog, without network refresh or loading sessions/extensions. Offset defaults to 0; limit is 1–100, default 30. Authorization requires effective `send`, `command` or `create` on a configured project, or `send`/`command` on an in-scope session. See [catalog details](model-control.md#session-independent-model-catalog).

### Set model

`set_model({session_id,model?,thinking_level?})` requires at least one setting and `send` permission. It changes the current selection, including while busy, and returns actual `{model:{provider,id},thinking_level}`. See [selection timing and owner support](model-control.md#standalone-selection-set_model).

### Compact

`compact({session_id,instructions?,interrupt?,timeout_ms?})` performs native compaction. It requires `send` and proven idle by default; explicit `interrupt:true` also requires `stop` and may abort the agent even if compaction fails. Success returns bounded completion metadata; summary text requires `read`. See [compaction support and results](model-control.md#manual-compaction-compact).

### Send

```json
{ "session_id": "ps_…", "text": "Review the change", "mode": "default" }
```

Requires `send` and text or images. Text is 1–100000 UTF-16 code units. Modes:

- `default`: ordinary native Enter semantics, steering while busy.
- `idle_only`: skip if busy/pending; a saved session may first cold-start.
- `steer`: use the native steering queue.
- `follow_up`: use the native follow-up queue.

`timeout_ms` is 50–30000, default 5000, and bounds acknowledgement rather than model execution. The result contains `status` (`started`, `queued`, `handled`, `skipped`, `rejected` or `unknown`) and a `reason` when needed. An owner unable to prove admission reports `unknown`; a handled command can still have reported a native extension error. Read [runtime events](reading.md#live-output-and-runtime-extension-events) for owned RPC errors and notifications.

Optional `model:{provider,id}` and/or `thinking_level` apply before input on a proven-idle Bridge-owned RPC. Busy, queued or unsupported owners refuse settings-bearing input. Verified settings add `model_selection:{model:{provider,id},thinking_level}`. See [prompt settings](model-control.md#prompt-model-and-thinking-settings) for non-atomic changes and timeouts.

Admission that cancelled an unsupported native dialog carries `reason:"EXTENSION_UI_CANCEL_SENT"`. [Runtime lifecycle](runtime.md#shutdown-and-in-flight-acks) describes dialog handling and automatic release.

### Image input (send and create)

```json
{
  "session_id": "ps_…",
  "text": "Describe this picture",
  "images": [{ "type": "image", "mimeType": "image/png", "data": "<actual base64 image bytes>" }]
}
```

For create, replace `session_id` with the configured absolute `project`. Image-only input is supported; Bridge adds `[Image attachment]` as neutral queue text.

- MIME types: PNG, JPEG, GIF and WebP. `data` must be canonical base64 without whitespace or a `data:` prefix; URLs, paths and attachment IDs are not fetched.
- There is no fixed image-count cap. Total decoded size is at most 5 MiB per send/create, within the shared 8 MiB serialized request limit. Native provider limits also apply.
- Bridge validates bytes and format signatures, then forwards native image blocks. Pi extensions and provider conversion retain their normal decoding, resizing and transformation behavior; image support is determined after native input processing.
- Owners must advertise image support or the whole submission returns `IMAGE_INPUT_UNSUPPORTED`. See [image-capable owners](runtime.md#image-capable-owners).

Native history and forks retain image blocks. Acknowledgement confirms admission, not visual interpretation. Stop returns queued text, not image bytes; withdrawn text is not an attachment backup.

### Native command

```json
{ "session_id": "ps_…", "command": "git status --short", "max_chars": 12000 }
```

Requires `command` permission. Pass the command without `!`; it uses Pi's native bash path, history, hooks and cancellation. Unsupported owners return `BASH_UNSUPPORTED`.

The result includes captured output, exit status, cancellation/truncation flags and generation. `timeout_ms` bounds acknowledgement, not shell lifetime; a separate authorized stop can interrupt a long command.

`max_chars` is 256–32768, default 12000, measured in UTF-16 units. `output_complete:false` means Bridge shortened the returned prefix; native `truncated:true` describes Pi's own truncation. There is no continuation. Use read with command selection for native history instead of rerunning a command to retrieve output.

### Stop

```json
{ "session_id": "ps_…", "max_chars": 12000 }
```

Requires only `stop`. It cancels native agent/bash activity, withdraws queued input in native order and returns `withdrawn_text`, including whether the capture contained an editor draft. Captured text can accompany an uncertain final acknowledgement. `max_chars` uses command's bounds; `withdrawn_complete:false` marks an incomplete prefix. Withdrawn unsent text may not exist in history, and there is no result continuation.

Stop never cold-starts Pi. It invalidates pending Bridge inputs, including batch items waiting for a lane or permission snapshot. An explicit stop→send sequence within one batch runs in order; a separate stop still withdraws pending input. Already-dispatched asynchronous native `input` or `user_bash` hooks may resume after Stop's acknowledgement. See [shutdown and in-flight work](runtime.md#shutdown-and-in-flight-acks).

A completed owned runtime may release normally; external owners stay open. Each stop acts on current work, so repeating it to retrieve old withdrawn text can interrupt a later run.

### Create and send

```json
{
  "project": "/home/example/project",
  "text": "Continue the review",
  "name": "Follow-up",
  "fork_from": "ps_PARENT"
}
```

`project` must exactly match a configured canonical path. The child uses the project's [native session destination](configuration.md#storage-and-project-paths); a destination outside configured roots returns `NATIVE_SESSION_OUTSIDE_ROOTS` before publication or input. `name` is optional, 1–200 code units. Text or images are required, with the same image and model/thinking rules as send.

Target `create` permission authorizes the first prompt; later sends need `send`. Optional `fork_from` additionally requires source `read` and copies the parent's current committed native branch, preserving native bookmarks. A live parent's native snapshot is authoritative; unsupported snapshot capability fails. The fork leaves its owner in place and waits if that owner is already releasing. See [read/fork boundaries](runtime.md#read-and-fork-boundaries).

The result contains `created`, the chosen child `session_id` when available, and nested `send` status/details. A failure after creation retains the child ID. The initial prompt holds the child's admission lane so later input cannot overtake it. Another create call creates another child.

### Delete

```json
{ "session_id": "ps_…" }
```

Requires only `delete`. It authorizes interruption of the target writer, including during release or handoff, and moves the native session to private trash while preserving project files. Delete fences new writers until termination and the move finish. A shared host that cannot close only this session returns `DELETE_SHARED_OWNER`; Bridge does not kill its other sessions. See [deletion lifecycle](runtime.md#explicit-deletion) for switching, process termination and partial failures.

Success returns a `restore_token` and project authorization scope. The manifest under `stateDir/trash` records original/trash paths. Restore is an owner operation: inspect the manifest and confirm writers are closed before restoring. Each new delete call is another attempt, not a lookup of the previous result.

### Batch

```json
{
  "operations": [
    { "op": "send", "args": { "session_id": "ps_A", "text": "Review A" } },
    { "op": "read", "args": { "session_id": "ps_A", "preset": "recent" } },
    { "op": "send", "args": { "session_id": "ps_B", "text": "Review B" } }
  ]
}
```

Wraps 1–10 operations of any other tool as `{op,args}`. Each item keeps its own permission checks, using the outer request's permission snapshot. Within a batch, same-session operations run in order through their ordinary return boundary, not model completion. Different sessions run concurrently; forks use the parent lane and independent creates can run concurrently in the same project. Results retain input order and item failures do not block later items. Invalid outer shape/count or size rejects before scheduling.

Items share a 196608-byte structured budget and the [MCP envelope budget](transports.md#bounds-and-errors). Mutation statuses, child IDs, restore tokens and verified settings are retained. Command/stop may return less than `max_chars`, with accurate completeness flags; auxiliary `command.fullOutputPath` and `delete.project` may be omitted.

Captured query pages may shrink while retaining their original snapshot and continuation. A query that cannot fit returns `BATCH_QUERY_BUDGET_TOO_SMALL` for that item. Batch does not reread after later mutations or rerun operations to fit the response. Repeating a batch repeats its mutations.

To interrupt a running command, send stop separately: a stop behind it in the same batch waits for the command's return or timeout.

### Health

```json
{ "session_id": "ps_KNOWN_OPTIONAL" }
```

Reports noteworthy permission combinations and source rules, deduplicating inherited issues. Healthy configurations return `{"domain":"permissions","status":"ok"}`. `{}` diagnoses defaults and configured projects; a known `session_id` limits diagnosis without exposing native metadata.

Unscoped health may additionally report:

- `restart_required:["setting",…]`: names of fixed settings changed since startup.
- `events:{status:"unavailable",reason:"…"}`: subscription storage could not be safely loaded.

These reports do not change grants or block core operations. See [configuration](configuration.md) and [event storage](events.md#authorization-storage-and-delivery) for remediation.
