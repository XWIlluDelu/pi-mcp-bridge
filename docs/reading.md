# Reading a Pi session

`read({session_id})` selects the last three input turns. Set `range.recent` for
more history, use `search` to locate evidence, or expand a result's refs.

The default source is an applicable [session reader](compatibility.md#session-specific-read-routing)
or Pi's native projection. `view:"session"` selects **Session Context**, the
effective context at a native leaf after compaction and context edits.
`view:"runtime"` selects a captured provider-request stage. Both tools require
`read` and work without starting Pi.

## Browse, find and expand

| Tool   | Example                                                                    |
| ------ | -------------------------------------------------------------------------- |
| Browse | `read({session_id, range:{recent:1}, content:{thinking:3,tool:0}})`        |
| Find   | `search({session_id, query:"retry policy", content:["assistant","tool"]})` |
| Expand | `read({refs:[item.ref, related.ref], max_bytes:12000})`                    |
| Next   | `read({cursor:page.next_cursor, max_bytes:12000})`                         |

`search` matches case-insensitive literal text across the session's selected
source, including reader titles and previews. Supply a nonempty `query` of up to
2048 UTF-16 units. Optional `content` limits the kinds searched. Results give
the query, match count, snippets and refs.

Browse and search accept an optional native `leaf_id`; explicit null selects
the empty root. Runtime captures use their own leaf. Both tools return preview
rows with `text`, `ref`, source locators and optional titles or related refs.
A shortened preview carries `truncated:true`. Reader `coverage` counts selection
before search and pagination, for example `{type:"memory",selected:3,total:12}`.

Expand up to eight refs from one session (including across captures) for frozen source content in original
order and formatting. Duplicate refs expand once. An `operation` link opens
a recorded nested tool call. Open a `source_context` link by itself for a fresh
Session Context read at the verified historical leaf.

Pass the next cursor from any page to `read` until it returns null. Cursors
inherit selection. Use a fresh browse to change `range` or `content`. Each call
can set `max_bytes` (4096–65536, default 24000) for the complete UTF-8 structured
page. See [MCP wire limits](transports.md#bounds-and-errors).

## Turn range and content

Turn selection defaults to `range:{recent:3,earliest:0}`. `recent:N` takes the last N turns
and `earliest:N` the first N. Overlaps count once. Use `-1` for all turns and `0` for none. For example,
`range:{recent:0,earliest:1}` selects only the earliest effective turn. Expanding
the range does not enable additional kinds or restore compacted-away history.

Each native user or mapped custom-input message establishes a new turn, including
steering input. A turn groups that input and its projected responses; paired tool
results stay with their call even when a steering input intervenes. It need not
be a completed task or a single model request. Text and image blocks remain one
input message. A hidden input or compacted prefix can leave an empty synthetic
boundary rather than a recoverable user message.

| `content` field | Default | Meaning                                                                                                                                                             |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input`         | `true`  | Include the selected turn's input message; hiding it does not hide the turn's replies.                                                                              |
| `assistant`     | `-1`    | Last N assistant messages with text or failure status per turn; default includes all.                                                                               |
| `thinking`      | `1`     | Last N messages with readable thinking per turn.                                                                                                                    |
| `tool`          | `1`     | Last N logical tool operations per turn; call and paired result count once.                                                                                         |
| `summary`       | `2`     | Background summaries, independent of turn range. Native active summaries form one group; positive values include that group. A reader counts its own summary items. |
| `memory`        | `3`     | Reader memory items in its documented order/scope, independent of turn range. Native Session Context has no memory store.                                           |
| `system`        | `false` | Native system instructions and sections.                                                                                                                            |
| `command`       | `0`     | Last N native shell command records, independent of turns.                                                                                                          |
| `native`        | `true`  | Other native/custom context in selected turns and global prefixes.                                                                                                  |

Count fields accept nonnegative safe integers or `-1`; `0` omits the kind and `-1`
includes all in its scope. Assistant and thinking are selected independently by
original message, not by text-block count. All blocks of a selected kind within
that message remain available and preserve source positions. A tool call with
recorded nested operations counts as one logical tool operation; its recorded
children have related refs. When system content is enabled, `tool:0` also omits
native tool declarations.

## Runtime request context

```json
{ "session_id": "ps_...", "view": "runtime", "max_bytes": 24000 }
```

Runtime Context captures the latest `context_with_system` observation, after
`context` handlers and before later request transformations. Search and refs
work on this capture. It has no native turn range or leaf selector. All kinds
are included by default. Count fields accept only `0` and `-1` here.

`observation` records the capture ID, time and generation, input leaf, current
leaf, intervening commits and whether the observing owner is still active.
Locations use `source.observation_index` instead of native entry IDs.
Subsequent answers belong to Session Context.

The observer keeps one cleaned capture within 32 MiB. Bridge also retains its
latest successful captures in memory for up to 16 sessions and about 32 MiB.
It captures owned RPC observations before normal release and retains successful
companion reads. A new owner with no capture can use the retained success if
its input leaf still matches the active ancestry. Retained observations keep
their original identity and report `source:"retained"`.

An unavailable capture reports `observation.available:false`, its reason and
empty items. An earlier success can remain retained through a failed read.
Hosts without observers report `host_observer_unavailable`. Bridge restart
clears retention.

## Native source content

Saved reads use Pi's parser and normalize in memory, discarding image bytes per
record. Optional `history` reports skipped malformed lines and an unterminated
tail. Duplicate entry IDs or a cycle on the requested branch make the read fail.
Live owners project and sanitize the selected leaf with their loaded Pi
SDK before transfer. Fork requests use a separate [raw snapshot](runtime.md#read-and-fork-boundaries).

Expanded pages (`presentation:"source"`) preserve the captured leaf, entry,
message and block positions, and `prompt_id`.

- Images retain MIME type with `data_omitted:true`.
- Assistant blocks retain termination status. Shared errors can appear as
  `message_metadata`. Internal signatures, response IDs and provider usage
  are removed. Tool arguments and business details survive.
- Tool calls retain their pairing status. Large recorded nested calls split
  into linked `nested_call` units with recorder completeness.
- Shell output retains execution flags and truncation state. Long command
  metadata can appear separately. `!!` records carry `in_model_context:false`.
- System sections and custom payloads remain pageable. Retained replies
  without an input use the synthetic `context_prefix` boundary.

## Optional input mappings

[Input mappings](compatibility.md#input-mapping) turn configured native custom
messages into prompt boundaries before selection. They preserve the original
content and details and identify the mapping in `source.read_adapter`.
Runtime Context keeps the captured request messages as supplied.

## Capacity and continuation

Pages advance in source order, including within long text. Rendering splits text
at Unicode code-point boundaries and preserves source and tool links.

`omissions.selection` counts content excluded by turn or kind selection.
`omissions.capacity` reports source items remaining and the position reached
before the page. Reader coverage describes its own source scope separately.

If shared metadata or nested-call fields cannot fit, `omitted_fields` names them
while preserving body text, parent identity and native error state. Other
indivisible content that fits a maximum page but exceeds the requested budget
returns `READ_BUDGET_TOO_SMALL` with `minimum_max_bytes` when known. Content too
large for any 65536-byte page becomes an explicit
`complete:false,reason:"oversized_indivisible_content"` omission; other history
remains pageable.

Batch assigns structured and duplicated-wire budgets before rendering the captured
snapshot. It never reacquires history after a later mutation. An indivisible unit
exceeding the shared budget returns an item budget error; read it separately.

## Frozen bounded snapshots

The cache retains detached, sanitized documents, with at most 64 snapshots and
about 32 MiB of accounted memory. Session and adapted search keep matches and
related sources. Runtime search budgets the entire provider-request capture.
If selected data exceeds the limit, Bridge returns
`READ_SNAPSHOT_TOO_LARGE`. Batch pins snapshots through assembly and reports
`READ_CACHE_BUSY` when the remaining cache cannot fit another capture.

Appends and owner changes leave a capture intact. Each page and expansion checks
read access under the [request’s permission snapshot](configuration.md#request-permission-snapshots),
plus canonical file, native ID and recorded cwd. Capacity eviction or a Bridge
restart produces `STALE_CURSOR` or `STALE_READ_REFERENCE`; start a fresh read or
search. Captures have no inactivity timeout.

## Live output and runtime extension events

`live` holds unfinished assistant output from cumulative native events.
Its tail is limited to 65,536 UTF-16 units including block overhead. It is
sampled with history on the first read. Cursor and explicit-leaf reads carry
no moving preview. `runtime_events` carries bounded owned-RPC extension
errors and notifications outside native history.
