# Public tool API

All inputs are strict objects; misspelled or obsolete fields are rejected.
The MCP tool definitions are generated from `src/tool-schemas.mjs`.
All examples below are **tool arguments**, not JSON-RPC envelopes.

## Sessions and mutations

A session ID is an opaque Bridge ID derived from the canonical native file path
and native session identity. It is not a filename or an entry ID. The same
identity remains stable across restart; moving/replacing the native identity
can change it. List permission controls discovery, not use of a known ID.

Every mutation requires a caller-chosen `request_id` matching
`[A-Za-z0-9._:-]{1,128}`. Reuse it only for the same operation, target and body.
Reuse with a different body yields `REQUEST_ID_CONFLICT`.
The durable receipt is written before dispatch. A replay never executes the
mutation again, including after process restart.

Common outcomes:

| Status     | Meaning                                                                                       |
| ---------- | --------------------------------------------------------------------------------------------- |
| `accepted` | Native/host admission or the specific control result was observed. Not model completion.      |
| `rejected` | Definite refusal; reason identifies the cause.                                                |
| `skipped`  | Deliberately not submitted, e.g. idle-only found busy or stop found no runtime.               |
| `unknown`  | Dispatch/outcome or durable recording is uncertain. Recover the same ID; never infer refusal. |
| `deleted`  | Session file moved to recoverable Bridge trash.                                               |

Tool-level errors use `isError:true` and JSON text
`{"error":{"code":"…"}}`. Operation receipts may instead contain a rejected or
unknown status. Batch records each item's receipt or error without collapsing
other items. A persistence failure after dispatch is reported with
`uncertain:true` and `recovery:"SAME_REQUEST_ID"`, never as definite refusal.
Unresolved late-result storage failures also make service shutdown fail visibly
after owned processes and locks are cleaned up; restarting is not permission
to resubmit the native operation with a new ID.

### List

```json
{ "project": "analysis", "name": "review", "active_after": "2026-10-01T00:00:00Z", "limit": 30 }
```

Optional filters: case-insensitive project-directory/name substrings,
`active_after`/`active_before` inclusive RFC3339 timestamps, and exact
`session_id`. They combine with AND. `offset` defaults to 0;
`limit` defaults to 30 and is bounded 1–100.

Results sort newest activity first, then session ID. Activity is native file
mtime, not a claim about last model completion. Rows contain `session_id`,
`project`, `name` (nullable), `parent_session_id` (nullable),
`last_activity` and `status`. Parent IDs require the parent's current list
permission; a child grant does not disclose a hidden parent. Metadata belongs
to list permission and is available independently of read permission.

Status is a sampled observation:

- `saved`: no cooperating live runtime found.
- `busy`: native activity, admission/preparation or pending work observed.
- `idle`: a source explicitly reports idle and no busy evidence conflicts.
- `unknown`: connected but insufficient idle evidence.
- `unavailable`: ownership/state could not be safely observed.

Use `list({session_id})` to observe a known session without adding another
status endpoint. In particular, native RPC `get_state` has no complete `isIdle`:
not streaming with an empty queue can still be `unknown` during preparation.
These are coarse agent/input observations, not per-request completion states;
control receipts and subsequent read output remain the result evidence.

Companion/host idle observations are used when supplied; a streaming or pending
signal takes precedence. Warm known-ID lookups revalidate the target file without
rescanning every session. Unchanged title metadata is cached; runtime status
and permissions are checked on each request.

Status includes observation time, pending-message count where available and
capability hints for connected runtimes. Listing never starts Pi.
`next_offset` is null at the end. Concurrent activity may reorder subsequent
pages; list is not a frozen export. `projects` lists configured destinations
currently permitted for create-and-send.

### Read

```json
{ "session_id": "ps_…", "preset": "recent", "max_bytes": 24000 }
```

See [reading](reading.md) for the single timeline format, seven selectors,
native content preservation, newest-first capacity paging, cursor binding,
fragment reconstruction and transient live output. Selection defaults to the
full effective context; capacity and explicit selection omissions are separate.
Every continuation reauthorizes read.

### Models, thinking, compact and reload

See [model discovery and native controls](model-control.md) for `models`,
`set_model` (model and/or thinking), idle-only `compact`, and targeted RPC
`reload`, including permissions, lifecycle and receipt recovery.

### Send

```json
{ "session_id": "ps_…", "request_id": "task-42", "text": "Review the change", "mode": "default" }
```

`text` is 1–100000 UTF-16 code units. The modes are:

- `default`: ordinary native Enter semantics, steer while busy.
- `idle_only`: skip if busy/pending; it may cold-start a saved session first.
- `steer`: native steering queue.
- `follow_up`: native follow-up queue.

`timeout_ms` (50–30000, default 5000) bounds admission acknowledgement, not
model execution. Queued input is an accepted submission, not a completed task.
Omit `text`, `images` and `model` and reuse the same session/request ID to recover a receipt.
Optional `model:{provider,id}` selects the persistent session model just before
submission on a proven-idle Bridge-owned RPC. Busy/queued/shared-owner cases
refuse the combination without enqueueing; see [model timing](model-control.md#model-plus-a-prompt).
A plain companion reports unknown acceptance when the public extension API
cannot prove admission; it does not invent a native ACK.

### Image input (send and create)

Both tools accept `images` in native Pi `ImageContent` format:

```json
{
  "session_id": "ps_…",
  "request_id": "image-1",
  "text": "Describe this picture",
  "images": [{ "type": "image", "mimeType": "image/png", "data": "<actual base64 image bytes>" }]
}
```

For `create`, replace `session_id` with the configured absolute `project`.
You may omit `text` for image-only input. The Bridge adds the neutral text
`[Image attachment]` because Pi 1.3 cannot clear consumed empty-text queue
entries; the picture still arrives as a native image block. Omitting **both** payload fields
(and `model`, if used) means receipt recovery, not a new empty prompt. Never resubmit uncertain work under a
new ID. Images participate in the durable request fingerprint: changing image
bytes, MIME type, count or order under the same ID is a conflict. Recovery does
not require uploading the images again.

- Accepted MIME types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`.
- One or more images, **no fixed count cap**; at most **5 MiB decoded bytes total**
  per send/create. Total bytes and serialized envelope size bound validation work; native model/
  provider-specific image limits still apply.
- `data` must be canonical base64, without whitespace or a `data:` prefix.
  URLs, local paths and client attachment IDs are not fetched or opened.
- The **8 MiB serialized request limit** still applies to HTTP, stdio and IPC.
  A batch shares that envelope limit; it is not multiplied by its item count.
- The Bridge validates base64, size and format signatures before dispatch.
  Pi retains its normal decoding, resizing and extension input behavior.
  A selected model without image input is rejected with
  `MODEL_IMAGE_INPUT_UNSUPPORTED`.
- Images enter native user-message image blocks, not descriptions, OCR text or
  base64 embedded in a text prompt. Native history and forked context retain
  those blocks; read pagination remains bounded even for large image records.
- Old companion/host endpoints without advertised image support return
  `IMAGE_INPUT_UNSUPPORTED` before sending, even when text accompanies the image.
  Reload/reopen them safely with the updated integration; never fall back to
  text-only delivery.

A native ACK confirms admission, not successful visual interpretation. Model
responses and any native image-processing diagnostics are read from the session.
Pi's native stop/queue-withdrawal APIs recover queued **text**, not image bytes;
a stop receipt must not be treated as an attachment backup.

### Native command

```json
{
  "session_id": "ps_…",
  "request_id": "shell-1",
  "command": "git status --short",
  "max_chars": 12000
}
```

The tool name is `command`, not `bash`. Pass the command **without** the leading
`!`. It uses Pi's native bash path, history, user-bash hooks and cancellation.
It never sends a disguised model prompt or starts a separate Bridge shell.

A supported owner returns output, exit status, cancellation/truncation flags and
a result generation. An unsupported owner returns `BASH_UNSUPPORTED`.
The timeout is an ACK wait, not a kill deadline; an independently authorized
stop can interrupt a long command.

Omit `command` with the same request ID to recover. `next_cursor` pages the
captured output; continue with the same ID. `max_chars` is 256–32768 and bounds
the control-output JSON field in UTF-16 units; the separate MCP wire cap
still applies. Native `truncated:true` describes native output truncation and
must not be confused with lossless Bridge pagination.

### Stop

```json
{ "session_id": "ps_…", "request_id": "stop-42", "max_chars": 12000 }
```

Requires only stop permission. It cancels native agent/bash execution,
withdraws queued inputs in native order and returns joined
`withdrawn_text`. Any already-available capture survives an uncertain ACK.
Continue `next_cursor` with the same ID until complete. The receipt reports
whether an editor draft was part of the supplied native capture.

Stop never cold-starts a session or intentionally closes its runtime.
Pending Bridge inputs not yet dispatched are invalidated rather than reviving
after stop. When a receipt exists, repeating its request ID replays that stop
without stopping a later run. Without a receipt, a request that omits `cursor`
can execute a stop for the first time.

If the first response was lost, query only the existing receipt from its first page:

```json
{ "session_id": "ps_…", "request_id": "stop-42", "cursor": "" }
```

This returns `RECEIPT_NOT_FOUND` without dispatching stop when no receipt exists.
Preserve the empty string: a truthy-value filter that drops `cursor:""` changes
this lookup into a possible execution. Use `next_cursor` for later pages. To
explicitly stop later work, use a new request ID without `cursor`.

### Create and send

```json
{
  "project": "/home/example/project",
  "request_id": "child-1",
  "text": "Continue the review",
  "name": "Follow-up",
  "fork_from": "ps_PARENT"
}
```

`project` must exactly match a configured canonical project path.
`name` is optional, 1–200 code units. `fork_from` is optional and identifies
the parent's **current committed native branch tail**, not an arbitrary
position or an unfinished assistant preview.

Only target create permission is needed for the first prompt; later sends
need send permission. A fork additionally requires source read. The source
writer remains in place. A live parent's native snapshot is authoritative;
unsupported snapshot capability is an explicit failure, never a disk fallback.

A receipt contains `created`, the child `session_id` when chosen, and nested
`send` status/details. If startup/submission fails after creation, the child ID
remains recoverable. The initial prompt holds the new session's admission lane
so a concurrently submitted prompt cannot overtake it.

Omit `text`, `images` and `model` with the same project/request ID to recover.
Missing both initial payload fields without an existing receipt yields `RECEIPT_NOT_FOUND`; it does not create an
empty session. If the process crashes before the created identity is durably
recorded, recovery may remain unknown; it still never creates a second child.

### Delete

```json
{ "session_id": "ps_…", "request_id": "delete-1" }
```

Requires delete permission independently of stop/read. Stops the owned runtime,
or uses a cooperating external owner's explicit release contract, then moves
the session to private trash. It does not remove project files.

The receipt returns a `restore_token` and project authorization scope. Its
restore manifest under `stateDir/trash` records original/trash paths. Recovery
requires current delete permission even after the original file is gone.
There is no remote restore tool: an owner must inspect the manifest, confirm
writers are closed and restore deliberately. Unknown partial moves remain
inspectable; never guess by creating another session or deleting the manifest.

### Batch

```json
{
  "operations": [
    { "op": "send", "args": { "session_id": "ps_A", "request_id": "a1", "text": "Review A" } },
    { "op": "read", "args": { "session_id": "ps_A", "preset": "recent" } },
    { "op": "send", "args": { "session_id": "ps_B", "request_id": "b1", "text": "Review B" } }
  ]
}
```

Wraps 1–10 operations of any other public tool, including list and health.
The outer request has no mutation ID or additional permission. Each item keeps
its ordinary arguments, grant checks and recovery ID.

Within one batch, operations for a session execute in input order **through
their ordinary receipt boundary**, not until model completion. Different
sessions run concurrently. A fork uses its parent lane; creates without a
parent share a destination-project lane. Results stay in original item order.
Malformed/denied/failed items do not block valid later items. Invalid outer
shape/count or an oversized batch rejects before scheduling.

The response has a 196608-byte structured ceiling and also fits the actual
duplicated text/structured MCP envelope budget. Captured reads are resized
without reacquiring mutable history, keeping usable continuation cursors.
An output too large to retain becomes an explicit `BATCH_RESULT_OMITTED` item
with recovery identity; mutations are never rerun merely to resize output.
A separate stop request can interrupt a running command; a stop behind it in
the same batch waits for that command's ordinary return/timeout.

### Health

```json
{ "session_id": "ps_KNOWN_OPTIONAL" }
```

Reports only noteworthy permission combinations and their relevant source rules,
deduplicating inherited issues. Healthy configurations return
`{"domain":"permissions","status":"ok"}` without normal permission tables.
`{}` diagnoses defaults and configured projects; an optional known `session_id`
limits diagnosis to that session, labeling source tiers without exposing native
metadata. The sole domain is `permissions`; explicit `domain:"permissions"`
remains accepted. See [configuration](configuration.md).
