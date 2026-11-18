# Reading a Pi session

`read({session_id})` selects the last three input turns. Set `range.recent` for
more history, use `search` to locate evidence, or expand a result's refs.

The default source is an applicable [session reader](compatibility.md#session-specific-read-routing)
or Pi's native projection. `view:"session"` selects **Session Context**, the
effective context at a native leaf after compaction and context edits.
`view:"runtime"` selects a captured provider-request stage. Both tools require
`read` and work without starting Pi.

## Browse, find and expand

Read the current turn with all assistant text and more recent thinking:

```json
{
  "session_id": "ps_...",
  "range": { "recent": 1 },
  "content": { "thinking": 3, "tool": 0 }
}
```

Find literal text across the reader's full supported source:

```json
{ "session_id": "ps_...", "query": "retry policy", "content": ["assistant", "tool"] }
```

Search matches literal text case-insensitively across one session's source,
including stored reader previews. Optional `content` limits kinds. Results
include `query`, `matches`, snippets and refs.

Expand references from one capture:

```json
{ "refs": ["<item.ref>", "<related.ref>"], "max_bytes": 12000 }
```

Ordinary refs return frozen, sanitized source content with original formatting.
Up to eight refs from one capture can be expanded together; duplicate refs expand
once. A `related` link with `relation:"operation"` opens a recorded nested tool
operation. A `source_context` link opens a fresh Session Context read at a verified
historical leaf. It describes that boundary, not an exact reconstruction of an
extension's source range. Open a source-context reference by itself.

Continue browse, search or expanded content by passing its `next_cursor` to
`read`, even when the first page came from `search`:

```json
{ "cursor": "<next_cursor>", "max_bytes": 12000 }
```

| Read argument | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `session_id`  | Required for a fresh browse; optional with cursor or refs.                                           |
| `view`        | Omit for automatic routing; `session` forces native projection, `runtime` reads a capture.           |
| `range`       | Input-turn range: `recent` defaults to 3, `earliest` to 0.                                           |
| `content`     | Independent content controls described below. Omitted fields use defaults.                           |
| `refs`        | One to eight references from one capture; only optional `session_id` and `max_bytes` accompany them. |
| `cursor`      | Opaque continuation of a frozen result.                                                              |
| `max_bytes`   | UTF-8 limit for the whole structured page: default 24000, range 4096–65536.                          |
| `leaf_id`     | Optional native leaf; explicit null means the empty root.                                            |

Search accepts `session_id`, nonempty `query` up to 2048 UTF-16 units, and optional
`view`, `content`, `leaf_id`, `max_bytes`. Runtime search rejects `leaf_id`.

Cursors inherit the capture's selection. Adjust `max_bytes` to fit more of that
selection. Change `range` or `content` in a fresh read. A null cursor ends the
page sequence. Expand a shortened item's ref for its full captured source.

## Turn range and content

`range` only selects input turns. `recent:N` takes the last N and `earliest:N` the
first N, with overlaps included once; `-1` includes all and `0` none. For example,
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
that message remain available and preserve source positions. A codemode batch
counts as one logical tool operation; its recorded children have related refs.
When system content is enabled, `tool:0` also omits native tool declarations.

## Previews and source coverage

Browse rows expose `text`, `ref`, source locators and optional titles or related
refs. A shortened preview has `truncated:true`. Tool previews show operations,
targets and recorded errors. Expand the ref for arguments or output.

Reader `coverage` reports its own source scope, for example
`{type:"memory",selected:3,total:12}`. Counts describe selection before search
and pagination. Optional `excluded` records source-rule exclusions.

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

## Native source preservation

Bridge uses the selected Pi's native parser and in-memory normalization. It
leaves the source file untouched. Optional `history` reports skipped malformed
lines and an unterminated tail. Frozen references retain the captured entry IDs.

## Source content and references

`presentation:"preview"` gives navigation rows. `presentation:"source"`
gives expanded native units with entry/message/block positions and `prompt_id`.
The page also carries the captured `leaf_id`, selection, omissions and cursor.
See [wire limits](transports.md#bounds-and-errors) for the MCP copies.

- Native images retain MIME type with `data_omitted:true`.
- Assistant blocks retain native termination status. Shared error details
  can appear as `message_metadata`. Internal signatures, response IDs and
  provider usage are removed while tool arguments and business details survive.
- Tool outputs stay paired with preceding calls even across steering input.
  `pairing` records unresolved or orphaned entries. Large recorded nested
  calls split into linked `nested_call` units with recorder completeness.
- Shell output retains execution flags and truncation state. Long command
  metadata can appear separately. `!!` records carry `in_model_context:false`.
- System sections and arbitrary native or custom payloads remain pageable.
  Hidden input creates an empty boundary. Retained replies without an input
  use `context_prefix`.

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

The cache retains detached, sanitized documents, with at most 16 snapshots and
about 32 MiB of accounted memory. Session and adapted search keep matches and
related sources. Runtime search budgets the entire provider-request capture.
If selected data exceeds the limit, Bridge returns
`READ_SNAPSHOT_TOO_LARGE`. Batch pins snapshots through assembly and reports
`READ_CACHE_BUSY` when the remaining cache cannot fit another capture.

Appends and owner changes leave a capture intact. Every page and expansion takes
a new [permission snapshot](configuration.md#request-permission-snapshots) and
checks canonical file, native ID and recorded cwd. Capacity eviction or a Bridge
restart produces `STALE_CURSOR` or `STALE_READ_REFERENCE`; start a fresh read or
search. Captures have no inactivity timeout.

## Live output and runtime extension events

`live` holds unfinished assistant output from cumulative native events.
Its tail is limited to 65,536 UTF-16 units including block overhead. It is
sampled with history on the first read. Cursor and explicit-leaf reads carry
no moving preview. `runtime_events` carries bounded owned-RPC extension
errors and notifications outside native history.

## Read costs and current components

Saved first reads parse history and discard image bytes per record before
projection. Unrelated dangling parents do not invalidate a usable branch;
duplicate IDs, invalid entries and traversed cycles reject. Owners select and
sanitize before transfer, so read IPC limits apply to cleaned snapshots rather
than unselected history. Continuations use only the cache, without fetching
entries or computing history fingerprints.

Live owners project current and historical leaves with their loaded Pi SDK.
See [component versions](architecture.md#component-versions) and
[owner reload](runtime.md#remote-reload). Fork uses a separate
[raw snapshot](runtime.md#read-and-fork-boundaries).
