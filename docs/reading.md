# Reading a Pi session

The public `read` tool returns one chronological timeline from Pi's current
effective session projection. It uses Pi's native `buildSessionProjection` for
branch ancestry, compaction checkpoints and context edits. It does not scan
abandoned branches into the result, rerun context hooks, or ask a model to
generate another summary.

This is the **Pi session projection, not the final provider payload**. In
particular, system sections, tool declarations, custom messages, images and
direct shell records remain native data. A `!!` shell record is readable, with
`in_model_context:false`; Pi excludes it later when converting model messages.

## Request

```json
{
  "session_id": "ps_...",
  "preset": "recent",
  "select": { "thinking": 0 },
  "max_bytes": 24000
}
```

Only these public arguments are accepted:

| Argument     | Meaning                                                                                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `session_id` | Required Bridge session ID. Knowing an ID does not grant access.                                                                       |
| `preset`     | `full` (default) or `recent`.                                                                                                          |
| `select`     | Optional overrides for the seven selectors below. Unknown selectors are rejected.                                                      |
| `max_bytes`  | UTF-8 byte limit for the **entire structured read result**, including metadata and continuation. Default 24,000; range 4,096–65,536.   |
| `cursor`     | Opaque backward continuation from a prior result. Repeat the same effective selection and session ID. The byte budget may change.      |
| `leaf_id`    | Optional explicit native leaf; `null` selects the empty projection. Usually omit this and let the first read capture the current leaf. |

The transport separately limits the complete MCP response envelope to 256 KiB,
including JSON-RPC metadata and any escaped text/structured duplication.
`max_bytes` is not a character count or that envelope limit. Batch response
budgeting can reduce an already captured read page without rerunning the read.

The old `view`, `max_chars`, text-locator and raw-history parameters are not part
of the public tool.

### Selection

| Selector           | Counting and selection                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `summary`          | `0` omits the logical summary; `1` or `-1` includes all currently active summary parts.                                |
| `recent_prompts`   | Last N user entries, or all with `-1`.                                                                                 |
| `earliest_prompts` | First N user entries, or all with `-1`.                                                                                |
| `text`             | Per selected prompt, first N **and** last N assistant text blocks; union by source position.                           |
| `thinking`         | Per selected prompt, first N **and** last N native thinking blocks.                                                    |
| `tools`            | Per selected prompt, first N **and** last N logical tool units (a call with its result, or an unresolved/orphan unit). |
| `commands`         | Last N native `bashExecution` messages, independently of prompt selection.                                             |

For all count selectors, `0` means none and `-1` means all. Counts are
nonnegative safe integers or `-1`; `summary` only accepts `-1`, `0` or `1`.
First/last overlap is included once, so a bidirectional count N selects at most
2N units per prompt. Text that happens to be identical is not deduplicated.

The `full` defaults are:

```json
{
  "summary": -1,
  "recent_prompts": -1,
  "earliest_prompts": -1,
  "text": -1,
  "thinking": -1,
  "tools": -1,
  "commands": -1
}
```

The `recent` defaults are:

```json
{
  "summary": 1,
  "recent_prompts": 3,
  "earliest_prompts": 0,
  "text": -1,
  "thinking": 3,
  "tools": 3,
  "commands": 0
}
```

Overrides replace individual preset fields; they do not reset the other fields.
For example, with the full preset, setting only `recent_prompts:1` still includes
all prompts because `earliest_prompts` defaults to `-1`. Use `recent`, or set
`earliest_prompts:0`, for recent-only selection.

System and custom messages have no matching selector and remain available.
Unknown native roles/blocks are preserved rather than silently discarded.
Assistant blocks of an unknown type follow their selected prompt. Non-context
extension state entries do not become timeline records.

## Timeline and prompt ownership

The result has `format:"context_timeline"`, `version:1`, and these main fields:

- `session_id`, `leaf_id`: the public session and the native leaf captured for
  this read.
- `selection`: all seven resolved selector values.
- `snapshot`, `snapshot_session`: opaque content and session identity bindings
  used for continuation.
- `items`: selected records in chronological projection order.
- `total_items`: selected record count before capacity pagination.
- `order:"chronological"`, `continuation:"backward"`, `next_cursor`.
- `omissions.selection`: counts excluded by the selection, in logical units
  `summary`, `prompts`, `text`, `thinking`, `tools`, `commands`.
- `omissions.capacity`: `records_before`, `records_after` and `fragmented`
  describe this page's position and whether it contains record fragments.
- `live`: a separately bounded, transient generation preview when available.

Each ordinary record carries `id`, `type`, `prompt_id`, `source` and
`record_index`. Its source includes native `entry_id`, projection
`entry_index`, and, where applicable, `message_index` and `block_index`.
`record_index` is its position in the selected snapshot. Ordering follows Pi's
projection and block order, not timestamps: a compaction checkpoint precedes its
retained suffix even though its raw file entry was written later.

Record types are `prompt`, `text`, `thinking`, `tool_call`, `tool_result`,
`command`, `system`, `custom`, `native` and `summary`. Native whole messages
remain in `message`; assistant blocks remain in `block`, with their remaining
message metadata in `metadata`.

A visible user entry's native entry ID is its `prompt_id`. A context-hidden user
entry still creates an empty synthetic prompt boundary, without exposing its
hidden text. An assistant/tool suffix retained without its original user entry
gets an empty `context_prefix` boundary. These synthetic boundaries participate
in prompt counting and selection.

Tool calls and results are paired **before** selecting prompts or sampling.
A result inherits the call's `prompt_id` and `tool_id`, but remains at its own
original timeline position. For example:

```text
Prompt A → tool call for A → steering Prompt B → tool result for A → answer for B
```

Selecting A can include both sides of its tool unit even when B is omitted.
`pairing` distinguishes `paired`, `unresolved` and `orphan_result`. Reused call
IDs match the latest preceding unresolved call; internal `tool_id` values use
source identity rather than text equality. Assistant ownership otherwise follows
the latest native user boundary: it is a repeatable record attribution, not a
claim that one steering input was the only cause of an answer.

The single `summary` item has ordered `parts:[{source,message},...]`.
Each part preserves its native compaction/branch-summary message and provenance.
Only summaries contributing to this projection are included; superseded raw
checkpoints are not concatenated. The collection occupies the first summary's
timeline position, while each part retains its original position. Complete native
system checkpoints are separate `system` records, not lost inside a short summary.

A page may contain an output whose earlier prompt record is on another page.
Follow `prompt_id` and source positions when combining pages; do not require
contiguous prompt subtrees.

## Capacity, continuation and reconstruction

The initial page contains the **newest** selected records that fit. Within every
page, records remain chronological. Follow `next_cursor` to retrieve progressively
earlier records. `records_after` on an older page describes newer records already
covered by later timeline positions, not a request to page forward.

The first read freezes its actual leaf. Subsequent appends, new compaction and
context edits do not change that old leaf's ancestor projection, so existing
continuations keep working. A fresh read without a cursor observes the new
context. Cursor validation binds the public/native session identity, resolved
selection, frozen leaf and selected projection contents, not the whole JSONL
revision. Removing that leaf or rewriting its selected projection yields
`STALE_CURSOR`; malformed cursors yield `INVALID_CURSOR`. Keep cursors opaque.

A single oversized record is returned losslessly across pages as fragments:

```json
{
  "type": "fragment",
  "record_type": "system",
  "record_index": 12,
  "encoding": "json",
  "offset_unit": "utf16_code_units",
  "offset": 6000,
  "total_units": 10000,
  "json_fragment": "..."
}
```

Fragments also carry the record's `id`, `prompt_id` and `source`.
The fragment text is a slice of the complete record's JSON encoding. It is not a
JSON object by itself. UTF-16 offsets support exact JavaScript string slicing;
the byte budget still measures UTF-8 bytes, including escaping. A fragment never
splits a surrogate pair.

To reconstruct:

1. Collect all pages; order records by `record_index`.
2. For a fragmented record, order its fragments by `offset`, check contiguous
   coverage from zero through `total_units`, and concatenate `json_fragment`.
3. JSON-parse the concatenated string to recover the original record.

Since continuation moves backwards, a giant newest record's **suffix** may
arrive first. Preserve offsets rather than concatenating pages in arrival order.
Ordinary records that fit alone are not fragmented merely to fill spare space
after newer records. Capacity omission never increments selection-omission
counts.

## Live generation

Native completed entries are the historical authority. On a fresh current-leaf
read, a capable runtime may additionally provide `live` from native message
events. Its payload uses at most one quarter of the requested read budget,
capped at 4,096 bytes.

A small preview uses `format:"message"` with its native partial assistant
`message`; known idle can have `message:null`. Selection applies to its
text/thinking/tool blocks, with `selection_omissions` and retained
`block_indices`. If the latest prompt was not selected, the live payload is
omitted with `omitted_by_selection:true`.

An oversized preview uses `format:"json_fragment"`, `complete:false`,
`json_fragment`, `offset:0`, `total_units` and `omitted_units`.
This is a bounded moving preview, **not** a lossless historical continuation.
Upstream truncation is marked too. Transport/batch rebudgeting can replace its
payload with `omitted_by_capacity:true` before shrinking historical items.

Live content is not included in the historical snapshot checksum. Continuations
and explicit-leaf reads return `live:null`, so a changing partial answer cannot
invalidate old pages. Sources without native live events report
`available:false`; this does not mean that the session is idle.

## Authorization

Bridge checks the independent `read` permission before acquiring data and
rechecks it after a captured read. Every continuation is a new authorized read.
A cursor is not an authorization token. `list:false` does not prevent a caller
who already knows the session ID from using an independently allowed read.

Reading does not start another Pi execution instance. Saved snapshots, owned RPC
snapshots and cooperative attached owners use the same renderer. An owner that
does not implement the new response contract is rejected with
`OWNER_READ_REFRESH_REQUIRED` instead of silently returning an old view.
