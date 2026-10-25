# Public tool API

Inputs are strict objects defined by `src/tool-schemas.mjs`. Examples below are tool arguments, not JSON-RPC envelopes. Tools expose no timeout parameter. Native and owner acknowledgements normally have a five-second budget; companion and host reload confirmation waits up to ten seconds. Owned RPC reload follows normal shutdown and startup, including native lifecycle hooks. These waits do not cancel native execution. Each request uses its [receive-time permission snapshot](configuration.md#request-permission-snapshots); ownership and execution checks remain live.

## Sessions and mutations

A `session_id` is an opaque Bridge ID derived from the canonical native file path and native session identity. It survives restart but can change when that identity moves or is replaced. List permission controls discovery; a known ID remains usable with the permission for the requested operation.

Every mutation call is a new operation, including identical calls. There is no deduplication or replay. Send/create return a `submission_id` once a target submission is tracked; `submission` can retrieve its admission receipt, including a late native ACK. This ID is not a Pi turn ID or a retry key. If the response itself is lost, or its receipt has expired, inspect `list/read` before deciding whether to submit again. Retain a returned child `session_id` even if create's initial send failed.

| Status       | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `started`    | Pi started a send/create prompt; model execution may still be running.         |
| `queued`     | Pi queued a send/create prompt.                                                |
| `handled`    | Native input handling completed, such as an extension command.                 |
| `dispatched` | An external owner invoked Pi; its public API cannot report native admission.   |
| `completed`  | A command, compaction or reload finished with the tool's completion evidence.  |
| `accepted`   | Stop was accepted; `acknowledgement` describes the available native evidence.  |
| `rejected`   | Definite refusal, explained by `reason`.                                       |
| `skipped`    | Not submitted, such as idle-only finding busy work or stop finding no runtime. |
| `unknown`    | Dispatch or outcome is uncertain.                                              |
| `created`    | The session was saved without submitting an initial prompt.                    |
| `deleted`    | The session moved to recoverable Bridge trash.                                 |

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

### Read and search

```json
{ "session_id": "ps_…", "max_bytes": 24000 }
```

`read` selects the last three input turns by default and returns content in source
order. `range:{recent:N,earliest:N}` selects turns; `recent:-1` includes all
effective turns. `content` independently controls input visibility and message or
tool counts. Defaults include all assistant text, the latest thinking message and
one logical tool operation per turn. Tools are short navigation; refs expand the
captured source. Each turn’s latest assistant text receives priority within the
page budget without changing display order.

Omit `view` to use a matching configured reader or native projection. Explicit
`view:"session"` selects Session Context; `view:"runtime"` selects a captured
request-stage Runtime Context. Adapted results identify `reader.id`. Both tools
require read permission and never start Pi.

Use `search` to find literal, case-insensitive text across one session's full
supported source, independently of the earlier brief selection:

```json
{ "session_id": "ps_…", "query": "retry policy", "content": ["tool", "assistant"] }
```

Expand useful result references with `read`:

```json
{ "refs": ["<item.ref>", "<related.ref>"], "max_bytes": 12000 }
```

Continue either tool's result through `read`, optionally changing the byte budget:

```json
{ "cursor": "<next_cursor>", "max_bytes": 12000 }
```

[Reading a Pi session](reading.md) defines source boundaries, selection, reference
combinations and Runtime restrictions. Its [continuation contract](reading.md#capacity-and-continuation)
describes page order. The [frozen snapshot contract](reading.md#frozen-bounded-snapshots)
covers retention and authorization.

### Models

`models({offset?,limit?})` returns `{models,next_offset}` from the owner's native configured catalog, without network refresh or loading sessions/extensions. Offset defaults to 0; limit is 1–100, default 30. Authorization requires effective `send`, `command` or `create` on a configured project, or `send`/`command` on an in-scope session. See [catalog details](model-control.md#session-independent-model-catalog).

### Set model

`set_model({session_id,model?,thinking_level?})` requires at least one setting and `send` permission. It changes the current selection, including while busy, and returns actual `{model:{provider,id},thinking_level}`. See [selection timing and owner support](model-control.md#standalone-selection-set_model).

### Compact

`compact({session_id,instructions?,interrupt?})` performs native compaction. It requires `send` and proven idle by default; explicit `interrupt:true` also requires `stop` and may abort the agent even if compaction fails. Success returns bounded completion metadata; summary text requires `read`. See [compaction support and results](model-control.md#manual-compaction-compact).

### Reload

```json
{ "session_id": "ps_…" }
```

`reload` requires `send` and refreshes an active owner's Pi resources. It has no
interrupt, wait or owner-specific options. It preserves saved history and resets extension-local state. The caller can use it after
`OWNER_READ_REFRESH_REQUIRED` or after changing the owner's resource settings.

| Result                                          | Meaning                                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`, `owner_version`, `read_compatible` | Native reload finished for the same session. The version identifies the loaded Bridge component; compatibility says whether it matches this Bridge.            |
| `skipped`, `reason:"no_active_owner"`           | No active owner to reload. Does not start Pi or clear an explicit local pause.                                                                                 |
| `rejected`, `reason:"RELOAD_BUSY"`              | Active or pending work prevents reload. Nothing is interrupted or queued for later.                                                                            |
| `rejected`, `reason:"RELOAD_UNSUPPORTED"`       | This owner does not implement reload.                                                                                                                          |
| `unknown`, `reason:"RELOAD_UNCONFIRMED"`        | Refresh may have started; completion could not be confirmed. Companion and host confirmation waits up to ten seconds. Inspect `list/read` before another call. |

`read_compatible:false` means native reload completed but the loaded Bridge
component still differs. Align the configured companion or host binding with
Bridge before retrying read. Repeated calls perform another reload; they are not
status lookups.

Bridge-owned RPC, ordinary TUI/RPC companions and SDK host bindings support
reload. RPC host bindings use the host's reload callback. A host binding remains
loaded while Pi resources reload; updating that binding follows its host's normal
component loading lifecycle. See [reload integration](runtime.md#remote-reload).

### Send

```json
{ "session_id": "ps_…", "text": "Review the change" }
```

Requires `send` and text or images. Text is 1–100000 UTF-16 code units. Modes:

- `steer` (default): start input when idle; use the native steering queue while busy.
- `idle_only`: skip if busy/pending; a saved session may first cold-start.
- `follow_up`: use the native follow-up queue while busy.

Bridge waits for native input admission where observable, not model completion. A tracked submission returns `submission_id` and `status`. Native ACKs establish `started`, `queued` or `handled`; `skipped` and `rejected` mean input was not submitted. An external companion/SDK owner that successfully invokes Pi returns `dispatched, admission:"unobservable"`: delivery to the Pi API is confirmed, but input hooks may still transform, handle or reject it. It is unnecessary to read history merely to confirm that dispatch, and it is unsafe to resend it automatically. A synchronous exception or transport uncertainty remains `unknown`. A handled command can still have reported a native extension error. Read [runtime events](reading.md#live-output-and-runtime-extension-events) for owned RPC errors and notifications.

Optional `model:{provider,id}` and/or `thinking_level` apply before input on a proven-idle Bridge-owned RPC. Busy, queued or unsupported owners refuse settings-bearing input. Verified settings add `model_selection:{model:{provider,id},thinking_level}`. See [prompt settings](model-control.md#prompt-model-and-thinking-settings) for non-atomic changes and timeouts.

Admission that cancelled an unsupported native dialog carries `reason:"EXTENSION_UI_CANCEL_SENT"`. [Runtime lifecycle](runtime.md#shutdown-and-in-flight-acks) describes dialog handling and automatic release.

### Submission receipt

```json
{ "session_id": "ps_…", "submission_id": "<ID returned by send/create>" }
```

`submission` returns `{session_id,submission_id,operation,receipt,submitted_at,updated_at,expires_at}`. The receipt contains `status` and optional `reason`/`admission`; it never contains prompt text or model output. After an owned RPC `unknown / ACK_TIMEOUT`, a later matching, identity-validated native ACK updates the same receipt to `started`, `queued`, `handled` or `rejected`. Querying neither resends input nor starts or contacts Pi.

Records are held in Bridge memory for at most one hour, with a limit of 256 newest submissions. Restart or eviction returns `SUBMISSION_UNAVAILABLE`, which says nothing about execution. A retained `unknown` is still uncertain; an external `dispatched` does not later turn into native admission evidence. Query requires current `read` or `send` permission, or current `create` permission for that initial-create receipt, and revalidates the saved session identity. It cannot recover an ID lost with the original response.

Use `list({session_id})` for current activity and `read({session_id})` for current useful content. A submission is not a work unit: several steering/follow-up inputs can share a run, and queued input can be withdrawn. Completion events remain session-wide and include a bounded last-response excerpt; pass their `read` object as tool arguments for more context at that fixed native leaf. See [collaboration design](collaboration.md).

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

The result includes captured output, exit status, cancellation/truncation flags and generation. `status:"completed"` means the native command returned a result; inspect `exitCode` and `cancelled` to determine how it ended. If the internal acknowledgement wait expires, the outcome is `unknown`: the command can still complete and store its result in native history. A separate authorized stop can interrupt a long command.

`max_chars` is 256–32768, default 12000, measured in UTF-16 units. Two independent flags describe output coverage:

- `native_truncated`: Pi truncated the original shell output. Its native result may be a tail and may include `fullOutputPath` for the full output.
- `response_complete`: Bridge returned all of that native result's output. False means `max_chars` or a batch response budget shortened its prefix. This is output coverage, not command completion or final acknowledgement.

Thus native truncation can coexist with a complete response (`true`/`true`), and Bridge can shorten either intact or natively truncated output (`false`/`false` or `true`/`false`). There is no continuation. Use read with command selection for native history instead of rerunning a command to retrieve output.

### Stop

```json
{ "session_id": "ps_…", "max_chars": 12000 }
```

Requires only `stop`. It cancels native agent/bash activity, withdraws queued input in native order and returns `withdrawn_text`, including whether the capture contained an editor draft. Captured text can accompany an uncertain final acknowledgement. `max_chars` uses command's bounds; `withdrawn_complete:false` marks an incomplete prefix. Withdrawn unsent text may not exist in history, and there is no result continuation.

`status:"accepted"` confirms the stop callback returned. `acknowledgement:"native_ack"` records a native acknowledgement; `"requested"` records a host's cancellation request.

Stop never cold-starts Pi. It invalidates pending Bridge inputs, including batch items waiting for a lane or permission snapshot. An explicit stop→send sequence within one batch runs in order; a separate stop still withdraws pending input. Already-dispatched asynchronous native `input` or `user_bash` hooks may resume after Stop's acknowledgement. See [shutdown and in-flight work](runtime.md#shutdown-and-in-flight-acks).

A completed owned runtime may release normally; external owners stay open. Each stop acts on current work, so repeating it to retrieve old withdrawn text can interrupt a later run.

### Create

```json
{ "project": "/home/example/project", "name": "Review" }
```

Omit `text` and `images` to save a session without starting a writer or model run.
This returns `{status:"created",created:true,session_id}` with no `send` or
`submission_id`. The saved session can be listed, read and subscribed to before
its first `send`. Model and thinking settings require an initial prompt; set them
on that later send when preparing an empty session.

To create and submit the first prompt together:

```json
{
  "project": "/home/example/project",
  "text": "Continue the review",
  "name": "Follow-up",
  "fork_from": "ps_PARENT"
}
```

`project` must exactly match a configured canonical path. The child uses the project's [native session destination](configuration.md#storage-and-project-paths); a destination outside configured roots returns `NATIVE_SESSION_OUTSIDE_ROOTS` before publication or input. `name` is optional, 1–200 code units. Supplied text, images and model/thinking settings follow the same rules as send.

Target `create` permission authorizes creation and its optional first prompt; later sends need `send`. Listing requires `list`; reading and subscribing require `read`. Optional `fork_from` additionally requires source `read` and copies the parent's current committed native branch, preserving native bookmarks. It also works without a prompt, so the copied context can be inspected before continuing. A live parent's native snapshot is authoritative; unsupported snapshot capability fails. The fork leaves its owner in place and waits if that owner is already releasing. See [read/fork boundaries](runtime.md#read-and-fork-boundaries).

The result contains `created` and the chosen child `session_id` when available.
When an initial prompt is supplied, it also contains nested `send` status/details
and a `submission_id` once tracked. A failure after creation retains the child ID.
The initial prompt holds the child's admission lane so later input cannot
overtake it. Another create call creates another child.

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
    { "op": "read", "args": { "session_id": "ps_A", "range": { "recent": 3 } } },
    { "op": "send", "args": { "session_id": "ps_B", "text": "Review B" } }
  ]
}
```

Wraps 1–10 operations of any other tool as `{op,args}`. The schema declares both fields and enumerates all supported operation names except `batch`; `args` uses the same parameter validation as the individual tool. Malformed items return `INVALID_OPERATION` without rejecting valid siblings. Each item keeps its own permission checks, using the outer request's permission snapshot. Within a batch, same-session operations run in order through their ordinary return boundary, not model completion. Different sessions run concurrently; forks use the parent lane and independent creates can run concurrently in the same project. Results retain input order and item failures do not block later items. Invalid outer shape/count or size rejects before scheduling.

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
