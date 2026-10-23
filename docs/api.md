# Public tool API

All inputs are strict objects; misspelled or obsolete fields are rejected.
The MCP tool definitions are generated from `src/tool-schemas.mjs`.
All examples below are **tool arguments**, not JSON-RPC envelopes.

## Sessions and mutations

A session ID is an opaque Bridge ID derived from the canonical native file path
and native session identity. It is not a filename or an entry ID. The same
identity remains stable across restart; moving/replacing the native identity
can change it. List permission controls discovery, not use of a known ID.

Every mutation call is a new operation. There is no caller-supplied mutation ID,
public result handle, lookup or replay API. Identical calls are not deduplicated.
The Bridge drains admitted work and native late-ACK checks before shutdown.
It keeps no business-operation journal or command/withdrawal result files.
Known native output travels within the original call, including bounded partial
output received before an uncertain final ACK.

Common outcomes:

| Status     | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `started`  | Native Pi started the send/create prompt. Not model completion.                 |
| `queued`   | Native Pi queued the send/create prompt.                                        |
| `handled`  | Native Pi handled the input, for example through an extension command.          |
| `accepted` | A control operation (command, stop or compact) returned its native result.      |
| `rejected` | Definite refusal; reason identifies the cause.                                  |
| `skipped`  | Deliberately not submitted, e.g. idle-only found busy or stop found no runtime. |
| `unknown`  | Dispatch or outcome is uncertain. Inspect list/read; never infer refusal.       |
| `deleted`  | Session file moved to recoverable Bridge trash.                                 |

Tool-level errors use `isError:true` and JSON text
`{"error":{"code":"…"}}`. Operation results may instead contain a rejected or unknown status.
Batch records each item's result or error without collapsing other items.

If a response is lost or unknown, the operation may already have happened.
Automatically resubmitting can duplicate work.
Use `list` to inspect session/owner activity and discover a partially created
session; use `read` to inspect saved inputs, assistant output and native command
history (include commands with the appropriate read selection). These are
observations, not per-prompt completion tracking. Decide whether another
operation is appropriate from that evidence. When create returns a child
`session_id`, retain it even if its initial send failed or is unknown.

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
control results and subsequent read output remain the result evidence.

Companion/host idle observations are used when supplied; a streaming or pending
signal takes precedence. Observed shell activity and unfinished control capture
also count as busy; an agent-only idle flag does not override them.
Warm known-ID lookups revalidate the target file without
rescanning every session. Unchanged title metadata is cached; runtime status
and permissions are checked on each request.

Status includes `model: {provider,id} | null` and `thinking_level` (a native level or null). These come only from a trusted live owner state observation, including when activity is `unknown`. Unobserved native selections return null; `saved` and `unavailable` always return null for both. Saved history and defaults are not used to guess a live selection. This metadata requires only list permission, and full native model/provider objects never enter the response.

Status also includes observation time, pending-message count where available and
`capabilities: {send, command, stop}` for connected runtimes, even when activity
is `unknown`. These describe operation-path support: prompt submission, native
shell execution, and stopping execution with queued-input withdrawal.
Each value is `true` (supported), `false` (known unsupported), or `null` (unconfirmed).
The object is absent for `saved` and `unavailable` sessions.

Bridge-owned RPC supports all three; ordinary TUI/RPC companions support only
send. Hosts support send through their required submit callback. Updated host
adapters report command only with both bash and stop callbacks, and stop with
a stop callback. Current hosts must declare these boolean capabilities; a missing or malformed declaration requires a component update.
Capabilities are independent of permissions and busy/idle state: they neither
grant access nor guarantee acceptance or success. Send mode still controls
busy-input admission. Listing never starts Pi.
`next_offset` is null at the end. Concurrent activity may reorder subsequent
pages; list is not a frozen export.

`creatable_projects` contains only the distinct projects represented by sessions actually returned on this page that are both configured create destinations and permitted for `create` in the same request snapshot. Filters, pagination and list permission determine the page first; an empty page returns `[]`, even when create is allowed by default. It does not enumerate every configured or authorized directory, and a session in an unconfigured subdirectory does not make that directory a create target. This is a page-local hint, not a restriction on `create`: callers may still create in any known configured, authorized project.

### Read

```json
{ "session_id": "ps_…", "max_bytes": 24000 }
```

`view:"native"` is the default. Explicit `view:"observed"` reads the
latest captured request-stage context, including MC transformations when
observed; it has no native selectors or leaf override. Missing observations are
explicitly unavailable, never recreated by running Pi. Owned observations survive
normal RPC release in a bounded Bridge-memory cache. See
[observed context](reading.md#observed-request-context) for stage, freshness and
retention semantics.

Native reads default to `preset:"latest"`: the last prompt, all assistant text
and first/last two thinking blocks, without summaries, tools or commands.
Use `preset:"recent"` for the last three prompts with summaries,
`select.tools` for calls and paired outputs, or `preset:"full"` for all effective
context. See [reading](reading.md) for the seven selectors, sanitized content,
byte budgets and live output.

Pages start with the newest selected content and continue backwards. Continue
with `cursor` alone (and optionally a different `max_bytes`); the view, session,
selection and leaf stay frozen. Conflicting overrides return `STALE_CURSOR`.
Snapshots have no inactivity timeout; cache eviction or Bridge restart also
returns `STALE_CURSOR`, requiring a fresh read.
Every continuation is a new request and reauthorizes read. Each call uses its
[receive-time permission snapshot](configuration.md#request-permission-snapshots)
through execution and response delivery.

### Models, set_model and compact

See [model discovery and native controls](model-control.md) for `models`,
standalone `set_model`, prompt model/thinking settings and `compact`, including
permissions, lifecycle and timeout behavior.

### Set model

`set_model({session_id, model?, thinking_level?})` requires at least one setting
and the target's `send` permission. It changes the current native selection,
including while busy, without sending a prompt. Success contains only
`{model:{provider,id},thinking_level}`, with actual native adjustments.
Unsupported owners return a tool error. See [selection and owner support](model-control.md#standalone-selection-set_model).

### Send

```json
{ "session_id": "ps_…", "text": "Review the change", "mode": "default" }
```

`text` is 1–100000 UTF-16 code units. The modes are:

- `default`: ordinary native Enter semantics, steer while busy.
- `idle_only`: skip if busy/pending; it may cold-start a saved session first.
- `steer`: native steering queue.
- `follow_up`: native follow-up queue.

`timeout_ms` (50–30000, default 5000) bounds admission acknowledgement, not
model execution. Queued input is an accepted submission, not a completed task.
After the run and queues finish, a proven-idle Bridge-owned RPC normally exits
and the session becomes saved. The next send can resume it; external owners
keep their own lifecycle. See [automatic release and its limits](runtime.md#runtime-capabilities).
At least one of `text` or `images` is required. Each call submits new input.
The result has exactly one `status`: `started`, `queued`, `handled`, `skipped`,
`rejected` or `unknown`. `reason` appears only when needed. There is no separate
`disposition`, operation wrapper or completion field. Only explicit model/thinking
settings can add `model_selection:{model:{provider,id},thinking_level}`, and
only after those values have been verified. A failed or timed-out setting does
not guess an actual value. A current native API that cannot establish admission
disposition returns `unknown`, not a fabricated accepted status.
Optional `model:{provider,id}` and/or `thinking_level` apply native session
settings just before submission on a proven-idle Bridge-owned RPC. Busy/queued/shared-owner cases
refuse the combination without enqueueing; see [model timing](model-control.md#prompt-model-and-thinking-settings).
A plain companion reports unknown acceptance when the public extension API
cannot prove admission; it does not invent a native ACK.
Successful send/create admission that required cancelling an unsupported dialog
includes `reason:"EXTENSION_UI_CANCEL_SENT"`; this warning is not a completion
claim. Lifecycle failures retain their specific reason. See the
[lifecycle UI limits](runtime.md#shutdown-and-in-flight-acks).
A throwing extension command can still receive a native `handled` admission ACK.
Owned RPC errors and notifications are observable through
[`read.runtime_events`](reading.md#live-output-and-runtime-extension-events).

### Image input (send and create)

Both tools accept `images` in native Pi `ImageContent` format:

```json
{
  "session_id": "ps_…",

  "text": "Describe this picture",
  "images": [{ "type": "image", "mimeType": "image/png", "data": "<actual base64 image bytes>" }]
}
```

For `create`, replace `session_id` with the configured absolute `project`.
You may omit `text` for image-only input. The Bridge adds the neutral text
`[Image attachment]` so native queues can remove the consumed entry by its
nonempty text; the picture still arrives as a native image block. Omitting **both** payload fields is rejected, including when model/thinking
settings are supplied. Identical image submissions are independent operations.

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
- Owners without advertised image support return `IMAGE_INPUT_UNSUPPORTED`
  before sending, even when text accompanies the image. Custom hosts must
  declare and implement image support; installed components must also be loaded
  by the running owner. See [image-capable owners](runtime.md#image-capable-owners).
  Images are never silently dropped in favor of text-only delivery.

A native ACK confirms admission, not successful visual interpretation. Model
responses and any native image-processing diagnostics are read from the session.
Pi's native stop/queue-withdrawal APIs recover queued **text**, not image bytes;
a stop result must not be treated as an attachment backup.

### Native command

```json
{
  "session_id": "ps_…",

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

`command` is required. `max_chars` is 256–32768 (default 12000) and bounds
the output JSON field in UTF-16 units; the separate MCP wire cap still applies.
Only one bounded output prefix is returned. `output_complete:false` means
the Bridge cut off the captured output; native `truncated:true` independently
describes truncation by Pi. There is no continuation or result lookup.
Use authorized `read` with command selection to inspect native history;
do not execute a command again merely to retrieve more output.

### Stop

```json
{ "session_id": "ps_…", "max_chars": 12000 }
```

Requires only stop permission. It requests native agent/bash cancellation,
withdraws queued inputs in native order and returns joined
`withdrawn_text`. Any already-available capture survives an uncertain ACK.
The result reports whether an editor draft was part of the native capture.
`max_chars` has the same bounds as command and limits the returned prefix.
`withdrawn_complete:false` means the returned text is incomplete; there is no
continuation or lookup. Unsent withdrawn text may not be present in history.

Stop never cold-starts a session. Once its recovery finishes, a Bridge-owned
prompt runtime may exit through normal automatic release; external owners stay open.
Pending Bridge inputs not yet dispatched, including batch items waiting for a
lane or permission snapshot, are invalidated rather than reviving after stop.
An explicit stop→send in one batch restarts in order; an external Stop still
withdraws pending inputs, and later batch stops never restore them. Already-dispatched requests awaiting an asynchronous `input` or
`user_bash` hook can resume and execute after Stop's native ACKs: Pi's queue
withdrawal and current-operation cancellation do not cancel those hook
continuations. Every new stop call acts on the current execution and queues,
including later work. Do not repeat stop merely to retrieve prior withdrawn text.

### Create and send

```json
{
  "project": "/home/example/project",

  "text": "Continue the review",
  "name": "Follow-up",
  "fork_from": "ps_PARENT"
}
```

`project` must exactly match a configured canonical project path. The child uses
that project's native Pi session location and effective agent environment, not
`sessionRoots[0]`. Native CLI/environment/settings overrides retain their normal
precedence; see [storage configuration](configuration.md#storage-and-project-paths).
If the native destination is outside the configured roots, creation rejects with
`NATIVE_SESSION_OUTSIDE_ROOTS` before publishing a session or sending the prompt.
`name` is optional, 1–200 code units. `fork_from` is optional and identifies
the parent's **current committed native branch tail**, not an arbitrary
position or an unfinished assistant preview. Pi's native fork preserves current
bookmarks, including updates or clears made outside that ancestry, and reconnects
retained entries after removing old label records.

Only target create permission is needed for the first prompt; later sends
need send permission. A fork additionally requires source read. The source
writer is not switched or restarted by the fork. If automatic release is already
closing it, the fork waits for that exit before acquiring the source. A live
parent's native snapshot is authoritative; unsupported snapshot capability is
an explicit failure, never a disk fallback.

A result contains `created`, the child `session_id` when chosen, and nested
`send` status/details. If startup/submission fails after creation, the child ID
remains available in the result. The initial prompt holds the new session's admission lane
so a concurrently submitted prompt cannot overtake it.

Text or images are required. Another create call creates another child.
If the first result is unavailable, inspect `list` and authorized `read`
before deciding whether to create again.

### Delete

```json
{ "session_id": "ps_…" }
```

Requires delete permission independently of stop/read. Stops the owned runtime,
or uses a cooperating external owner's explicit release contract, then moves
the session to private trash. It does not remove project files.

The result returns a `restore_token` and project authorization scope. Its
restore manifest under `stateDir/trash` records original/trash paths. A repeated call is a new deletion attempt, not a lookup of the prior result.
There is no remote restore tool: an owner must inspect the manifest, confirm
writers are closed and restore deliberately. Unknown partial moves remain
inspectable; never guess by creating another session or deleting the manifest.

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

Wraps 1–10 operations of any other public tool, including list and health.
The outer request adds no permission. Each item keeps its ordinary payload and
grant checks. All items use the same permission snapshot captured when the
authoritative Bridge receives the outer request, including items waiting in a
lane. Every mutation item executes independently; repeating a batch can repeat
all its mutations.

Within one batch, operations for a session execute in input order **through
their ordinary return boundary**, not until model completion. Different
sessions run concurrently. A fork uses its parent lane; independent creates run concurrently even in the same destination project. Each child has its own identity/publication and admission lock. Results stay in original item order.
Malformed/denied/failed items do not block valid later items. Invalid outer
shape/count or an oversized batch rejects before scheduling.

Before execution, batch divides its 196608-byte structured ceiling and actual
duplicated text/structured MCP wire budget among the items, including item wrappers,
UTF-8 and JSON escaping. Mutation status, child session IDs, restore tokens and
actual model settings are retained; batch never drops whole mutation results to fit.

Command and stop render their captured output within the assigned budget.
`max_chars` remains an upper bound: batch may return a smaller prefix, with
`output_complete` / `withdrawn_complete` reflecting exactly what was returned.
Auxiliary `command.fullOutputPath` and `delete.project` may be omitted when they
do not fit; standalone calls retain their ordinary fields.

Captured reads are resized without reacquiring history after a later mutation,
keeping their original snapshot and usable continuation cursors. Captured list
and model pages may be shortened with an adjusted `next_offset`. A query that
cannot fit even a smaller page returns `BATCH_QUERY_BUDGET_TOO_SMALL` for that
item, without displacing any mutation result or executing an operation again.
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
metadata. `domain` is a result label, not an accepted input parameter.
Unscoped `health({})` also includes `restart_required:["setting",…]` when fixed
settings differ from the active service configuration. Only names are returned,
not configuration values; permission status and business admission are unchanged.
See [configuration](configuration.md).
