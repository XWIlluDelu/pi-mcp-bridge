# Reading a Pi session

`read` defaults to `view:"native"`: Pi's persisted session projection as readable,
prompt-linked semantic units. Pi's native `buildSessionProjection` determines branch ancestry,
compaction checkpoints and context edits. The Bridge pairs tools and applies
selectors **before** sanitizing and segmenting selected records.

This is a reading view, not the final provider payload or a lossless native
export. It does not rerun context hooks, scan abandoned branches or generate
another summary.

## Request

```json
{ "session_id": "ps_...", "max_bytes": 4096 }
```

To continue, pass the returned cursor alone; the byte budget may change:

```json
{ "cursor": "<next_cursor>", "max_bytes": 12000 }
```

| Argument     | Meaning                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------- |
| `session_id` | Required for the first read; optional with a cursor. Knowing an ID is not permission.         |
| `view`       | `native` (default) or `observed`. Omitted on continuation: inherit.                           |
| `preset`     | Initial default `latest`; alternatives `recent` and `full`. Omitted on continuation: inherit. |
| `select`     | Overrides for the eight selectors below. Omitted continuation fields inherit.                 |
| `max_bytes`  | UTF-8 limit for the entire structured page: default 24000, range 4096–65536.                  |
| `cursor`     | Opaque backward continuation of one captured snapshot.                                        |
| `leaf_id`    | Optional native leaf. Explicit `null` means the empty root, not the last file entry.          |

An explicit continuation preset, merged with its explicit selectors, must match
all eight captured values. Without a preset, only explicitly supplied selector
fields are checked. An explicit session or leaf must also match; mismatches
return `STALE_CURSOR`. Defaults are not applied before deciding what to inherit.

Every read, including a cursor-only read, uses its own receive-time permission
snapshot and validates the current canonical file/native session identity.
A cursor is not authorization. It cannot be reused across Bridge instances.

## Observed request context

```json
{ "session_id": "ps_...", "view": "observed", "max_bytes": 24000 }
```

This view reads the latest passively captured `context_with_system` event,
including request-local memory transforms. Every `context` handler runs before
this phase, so Magic Context's tags, drops and injected Historian summaries are
observed even when MC loads after the Bridge observer. Later
`context_with_system` handlers, Pi projections and provider conversion may still
change the request. This is a request-stage observation, not final provider
payload or confirmation that dispatch succeeded.

The entire captured array is eligible for paging, without native
`preset`, `select` or `leaf_id` overrides. These arguments reject rather than
misidentifying synthetic history as native prompts. `selection` and
`omissions.selection` are null. Items use `source.observation_index`, with
content/part positions where split; no native entry or prompt IDs are invented.
The same sanitization, Unicode-safe semantic paging, byte and batch budgets apply
to both views. Cursor-only continuation inherits the view and freezes all
observation metadata; conflicting view or native-selector overrides reject.

`observation.available:true` carries:

- `id`, `observed_at`, `owner_generation` and
  `phase:"context_with_system_observer"`.
- `input_leaf_id` (also the page's `leaf_id`): the native leaf at capture.
- `current_leaf_id`, `later_committed_entries` and `checked_at`: branch ancestry
  and intervening native commits checked at the first read.
- `owner_active`: whether the capture came from the current live observer, rather
  than retained data. `false` does not mean that no process currently owns the session.

An answer generated after capture is not part of that observation. Read the
native view for subsequent committed answers. An observation remains a dated
request snapshot even when no new native entries appeared; idle memory changes
are not recomputed by reading.

Updated companions and Bridge-owned RPCs capture one bounded cleaned snapshot
per runtime. Before normal owned RPC exit, Bridge retains the snapshot when
available, without needing a prior external read. Bridge keeps at most 16 sessions and
approximately 32 MiB of accounted observation data, latest per session, in
addition to the existing frozen-page cache. The observer also has a 32 MiB
accounted capture limit. Retention does not keep the writer alive or persist observations to disk. A successful observed read from a companion is also retained
for later switch-away/exit. A new live owner is queried first. If it has not
captured a request yet, an existing successful capture remains readable as
`source:"retained"`, with its original ID, time, owner generation and input leaf,
and `owner_active:false`. The current leaf and intervening commits are checked
against the new owner's reported active branch, not merely the saved file's tail.
No-prompt operations such as model changes or a rejected compact do not erase a
capture when their cold-started owner exits.

Only a successful capture replaces retained content. Failed live captures remain
explicitly unavailable in that read; an unavailable reply or transport failure
does not erase an older retained capture. Publication ordering still fences delayed
reads from an older capture or a retired owner. Without a live owner, saved reads
check the captured input leaf still belongs to the saved branch.

No available capture, a failed/oversized live capture or a changed branch returns
`observation.available:false` with a reason and empty items. Retained observations
are lost on eviction or Bridge restart; an available live observer can still
supply its snapshot. A host without an observer returns
`host_observer_unavailable`; its native view remains available. Reads never start Pi, call a model, rerun context hooks,
write session history or access MC's database. Normal agent work creates the
observations; an already-running old companion must be updated with the Bridge.

## Native selection

| Selector           | Counting and selection                                                                                                             |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `system`           | `0` omits native system instructions/sections; `-1` includes them in native order. Tool declarations also require nonzero `tools`. |
| `summary`          | `0` omits summaries; `1` or `-1` includes all active summaries at their native positions.                                          |
| `recent_prompts`   | Last N user entries, or all with `-1`.                                                                                             |
| `earliest_prompts` | First N user entries, or all with `-1`.                                                                                            |
| `text`             | Per selected prompt, first N **and** last N assistant text blocks; union by source position.                                       |
| `thinking`         | Per selected prompt, first N **and** last N native thinking blocks.                                                                |
| `tools`            | Per selected prompt, first N **and** last N logical tool units (a call with its result, or an unresolved/orphan unit).             |
| `commands`         | Last N native `bashExecution` messages, independently of prompt selection.                                                         |

For all count selectors, `0` means none and `-1` means all. Counts are
nonnegative safe integers or `-1`; `summary` only accepts `-1`, `0` or `1`, and
`system` only accepts `-1` or `0`.
First/last overlap is included once, so a bidirectional count N selects at most
2N units per prompt. Text that happens to be identical is not deduplicated.

For an initial read, omitting `preset` is equivalent to `preset:"latest"`:

```json
{
  "system": 0,
  "summary": 0,
  "recent_prompts": 1,
  "earliest_prompts": 0,
  "text": -1,
  "thinking": 2,
  "tools": 0,
  "commands": 0
}
```

This selects the last prompt with all assistant text and the first/last two
thinking blocks. It omits system instructions, summaries, extra earliest prompts,
tool units and direct shell commands. Native system records can be large repeated
background, so they do not consume the default conversation page. Their omission
is counted in `omissions.selection.system`, not silently truncated. Use
`select:{system:-1}` to include them, or `preset:"full"` for all effective context.
Omitting system does not hide custom messages or affect the observed view.
Active summaries remain controlled by `summary`.

Explicit `preset:"recent"` uses:

```json
{
  "system": 0,
  "summary": 1,
  "recent_prompts": 3,
  "earliest_prompts": 0,
  "text": -1,
  "thinking": 3,
  "tools": 0,
  "commands": 0
}
```

This includes active summaries and the last three prompts with all assistant
text and the first/last three thinking blocks per prompt. It adds no earliest
prompts and omits system instructions, tool units and direct shell commands.

To extend the default `latest` with the first/last two tool units and the earliest
prompt as well:

```json
{ "session_id": "ps_...", "select": { "tools": 2, "earliest_prompts": 1 } }
```

Each tool unit includes its call arguments and paired result output; unresolved
calls and orphan results retain their pairing status. Selected records remain
subject to capacity paging. Set `select.tools:-1` for all tools in the selected
prompts.

When system records are included, `tools:0` omits their
`toolsAdded`/`toolsRemoved` declarations and records containing nothing else;
instruction text and section updates/removals remain. Nonzero `tools` includes
those declarations only when `system:-1`; tool calls/results remain independently
selectable. Declarations do not count as per-prompt tool units. Custom messages
still follow their prompt windows.

Explicit `preset:"full"` selects everything:

```json
{
  "system": -1,
  "summary": -1,
  "recent_prompts": -1,
  "earliest_prompts": -1,
  "text": -1,
  "thinking": -1,
  "tools": -1,
  "commands": -1
}
```

Overrides replace individual preset fields; they do not reset the other fields.
For example, with the full preset, setting only `recent_prompts:1` still includes
all prompts because `earliest_prompts` defaults to `-1`. Use `latest` or `recent`,
or set `earliest_prompts:0`, for recent-only selection. With `latest`, overriding
only `recent_prompts:3` keeps summaries omitted and thinking at first/last two;
it does not switch to `recent`.

Saved v1/v2 histories are normalized in memory with native pure parsing/migration. Malformed records are skipped as in Pi. Optional `history` reports `skipped_malformed_lines` and `unterminated_tail`; reads never modify file bytes. Native writer open alone performs disk repair/migration. Native v1 entry IDs are assigned in memory and need not match between fresh reads; cursor pages retain their captured IDs.

## Readable content

A page contains `session_id`, `view`, acquisition `source`, captured `leaf_id`,
resolved `selection`, chronological `items`, `omissions`, `live` and
`next_cursor`. Runtime extension observations may appear in `runtime_events`.

The MCP envelope carries this same result as JSON text in `content` and as
`structuredContent`, for text-consuming and structured clients respectively.
Consume either representation, not both as separate history. `max_bytes` bounds
the structured page; the separate wire budget includes both copies.

Units retain their native source entry/message/block positions and `prompt_id`.
Ordinary message data is in `message`; assistant blocks are in `block`, with
a small allowlist of time/model/thinking/stop/error metadata. Types include
prompt, text, thinking, tool call/result, command, system, custom, native and summary.
Large message/block fields use source-linked `message_metadata` units rather
than being copied into every text segment.

- Native image blocks become
  `{type:"image",mime_type:"image/png",data_omitted:true}`.
  No base64, image decoding or invented image link is returned.
- Assistant text/thinking parts retain `stopReason` in both views, so an error or
  cancellation remains visible on the latest page. Large error details stay in
  shared metadata instead of repeating with each part.
- Native text/thinking signatures, response IDs, replay metadata, usage/cost
  and diagnostics are excluded. Tool arguments and business `details` are not
  recursively stripped because a key happens to be called `signature`.
- Tool calls retain name, namespace, arguments/errors and pairing. Results retain
  tool identity, output and error state. Retained arguments/details stay whole;
  oversized metadata fields are named explicitly when omitted.
- Saved `nestedCalls` stay with their parent tool selection. Small snapshots remain
  whole; larger ones use complete `nested_call` items with parent/source links.
  `nested_calls_complete` preserves the native recorder's completeness independently
  of `next_cursor`. Native `argumentsBytes`, error and unfinished status remain
  native observations; child result bodies that were not saved are not invented.
- Commands keep command/output and exit/cancellation state. Each paged output
  chunk repeats `exitCode`, `cancelled` and native `truncated` when present, plus
  command/path strings of at most 256 encoded JSON bytes each. Larger command/path
  fields stay in one metadata item linked by `source.entry_id`; a small page can
  explicitly omit those indivisible fields. Native truncation is separate from
  pagination capacity omissions. `!!` records expose `in_model_context:false`,
  not a claim that Pi included them in a provider call.
- System sections remain readable; tool declarations follow the `tools`
  selection above. Large known section text is segmented before arbitrary-object
  limits are applied.
- Active summary provenance and global/context-prefix native content remain available. Custom and unknown native records attributable to a prompt follow that prompt window; `full` retains all of them, subject to explicit capacity limits.

Prompt ownership and tool pairing do not change. A context-hidden user creates
an empty synthetic boundary without leaking its hidden text. A retained suffix
without its user gets a `context_prefix` boundary. Calls/results are paired
before sampling, even across a steering prompt. `pairing` distinguishes paired,
unresolved and orphan units; reused call IDs resolve to the latest preceding
unresolved call. Identical text from different source positions is not deduplicated.

## Capacity and continuation

The first page contains the newest selected units that fit, in chronological
order. Following `next_cursor` moves toward earlier units.
`omissions.selection` counts native logical records excluded by selectors;
`omissions.capacity.earlier_units` and `later_units` locate the page within its
captured selected units. Later units on an older page are already-covered newer
content, not a forward-page request.

Small blocks remain whole. Long prose prefers paragraphs and complete lines. Long single lines split at whitespace or Unicode code point boundaries, repeating necessary source/tool context. Segments can carry a `part`
ordinal within their original block; message parts retain its native `content_index`. Each item is independently readable:
**do not concatenate JSON slices or parse reconstructed records**.
Selector counts still refer to native prompts/blocks/tool units, never paragraphs.

If shared metadata or an individual nested-call field cannot fit the page,
`omitted_fields` names the omitted indivisible fields while retaining body text,
parent identity and native error state. Other indivisible content that fits a
maximum page but not the requested budget raises
`READ_BUDGET_TOO_SMALL`, with `minimum_max_bytes` when known. Increase the budget;
a small request does not permanently discard ordinary content. Other content that
cannot fit even a 65536-byte page becomes an explicit
`complete:false,reason:"oversized_indivisible_content"` omission. Earlier and
later history remains pageable.

Batch gives read its internal structured and duplicated-wire budget **before
the first render**. It pages the same captured snapshot, without reacquiring
history after a later mutation. An indivisible unit that exceeds the shared wire
budget returns an explicit item budget error; read it separately with more room.

## Frozen bounded snapshots

Snapshots retain detached sanitized units only: not raw native entries, base64,
or a second set of complete JSON encodings. The cache holds at most 16 snapshots
and approximately 32 MiB of accounted memory. Selected data exceeding this bound
returns `READ_SNAPSHOT_TOO_LARGE`; selectors are not silently narrowed.

A continuation cursor is returned only after its snapshot was successfully cached.
Batch pins its still-needed cursor snapshots until response assembly; temporary
capacity pressure returns `READ_CACHE_BUSY` rather than evicting another active
batch result. A page containing everything needs no cached snapshot.

Snapshots have no inactivity timeout. LRU/capacity eviction or Bridge restart returns `STALE_CURSOR`; start a fresh read. The Bridge
does not recreate an old cursor from mutable history. Once captured, normal
appends, owner exit, automatic release or a new owner generation do not change
the frozen history. Each continuation rechecks read permission and native identity,
including the header cwd; changing that identity invalidates the cursor.

## Live output and runtime extension events

`live` is a separately bounded, transient and incomplete observation, outside
historical cursor paging. It uses the same signature/image sanitization and
readable units. Capacity omissions are explicit; no half-JSON preview is returned.
The observer and renderer retain the newest tail, trimming oversized text/thinking blocks at Unicode-safe boundaries with explicit truncation. The observer's 65,536 UTF-16-unit budget includes a per-block overhead charge, so short or empty blocks cannot grow it without bound. A larger byte budget can expose more of that tail. Historical cursors and explicit-leaf reads do not return a moving preview.

`available:false` and a reason describe unavailable/invalid observations.
An empty observed live item list means no unfinished assistant text was observed,
not that all agent/tool work is idle. Invalid native observations are explicitly
unavailable. Native observer truncation remains visible. Final committed history
is authoritative.

`runtime_events` contains bounded, generation-scoped transient extension errors
and notifications where the owned RPC exposes them. It is neither historical
context nor a receipt/completion tracker.

## Read costs and current components

Saved first reads parse native history and drop image content bytes per record
before building the projection; raw fork loads preserve those bytes. Unrelated
dangling parents do not disqualify a usable current branch. Duplicate IDs, invalid
entry shapes and cycles encountered during branch traversal still reject; reads
do not repair the source. Owned RPC
selects and sanitizes inside its Pi observer, transferring the same cleaned read
contract as companions/hosts rather than the entire raw history. Its live preview
and committed projection are captured together. No extra history index is kept.

Continuations read only the captured snapshot: they do not fetch entries or
compute full-history fingerprints.

Owner `op:read` replies contain only selected native or observed sanitized snapshots;
Bridge paginates them uniformly. Their read IPC ceiling applies to the cleaned
snapshot, not unselected raw history. Attached fork still uses the raw `snapshot`
operation with its 32 MiB bound; owned fork uses native `get_entries`.

Update the Bridge and companion/host components together. A missing or mismatched
read contract returns `OWNER_READ_REFRESH_REQUIRED`; update the companion/host
at an idle boundary. Tool errors expose the same code in text and
`structuredContent`, with refresh guidance for this error. Changing read
selectors or refreshing the client's schema does not update a running owner.
Read never falls back to the raw fork snapshot. Native Pi history still uses
the current SDK projection without modifying historical records.
