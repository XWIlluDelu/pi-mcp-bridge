# Reading a Pi session

Start with `read({session_id})`. It selects the last three input turns and returns
readable content in source order, with short tool navigation and refs for deeper
reading. Use `range:{recent:1}` for only the current turn, or `search` to locate a
particular decision or result without expanding the browsing range.

Both tools use a matching explicitly enabled session reader, otherwise Pi's native
projection. `view:"session"` forces **Session Context**: the effective native
context at a leaf. `view:"runtime"` selects **Runtime Context**: a captured request
stage. Reader results identify `reader.id` and use `view:"adapted"`; callers do not
need a plugin name to select the default path. [Module routing](compatibility.md#session-specific-read-routing)
defines activation and content contracts.

Native `buildSessionProjection` determines branch ancestry, compaction checkpoints
and context edits. All effective turns means the retained context at that leaf,
including active summaries, not the entire raw session log. Reading and searching
never start Pi, call a model, rerun context hooks or write history.

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

Search is case-insensitive literal matching, independent of browse counts and
preview lengths. Its optional `content` array uses the same kind names as
`read.content`; it restricts kinds, not their counts. Search returns `query`,
`matches`, snippets and refs. It searches one authorized session, not other
sessions, hidden raw history or content the source never captured.

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

Continue browse, search or expanded content with its cursor:

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

A continuation inherits its capture's source, leaf and content range. Repeated
arguments must agree with that capture; changing them requires a fresh read.
The simplest continuation is cursor-only. Each page and ref expansion takes a
new [permission snapshot](configuration.md#request-permission-snapshots) and
validates native identity. A cursor or reference does not grant access or cross
Bridge instances.

## Turn range and content

`range` only selects input turns. `recent:N` takes the last N and `earliest:N` the
first N, with overlaps included once; `-1` includes all and `0` none. For example,
`range:{recent:0,earliest:1}` selects only the earliest effective turn. Expanding
the range does not enable additional kinds or restore compacted-away history.

Each native user or mapped custom-input message establishes a new turn, including
steering input. Its text and image blocks remain one input message. A hidden
input or compacted prefix can leave an empty synthetic boundary rather than a
recoverable user message.

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

Browse items contain `type`, `text`, `ref`, source locators and optional `title`
and `related` refs. Public kinds match the content controls; reference expansion
exposes the underlying native unit types. Messages remain in source order.
The reader does not generate a new summary or infer task success from a reply.

Input, ordinary assistant and thinking previews use an internal limit of 1600
UTF-16 units; background previews use 900. They preserve meaningful newlines and
indentation, collapse excessive blank lines, and use roughly 65% beginning plus
35% ending when shortened. Search uses a 640-unit excerpt around the match.
The latest body reply in each selected turn is allowed more room and is returned
in full when the page budget permits. `truncated:true` marks shortened prose;
its ref retains the captured source. `max_bytes` controls the page, not a public
per-message length setting.

Tool navigation names the operation and target, recorded status and necessary
diagnostics; it does not paste ordinary stdout into the overview. Native tool
errors and nested-call failure clues are retained as evidence of that operation,
not a claim that the current task remains blocked. Nested refs expose only what
native history recorded; missing child output is not synthesized.

Reader items retain provenance and may supply concise previews. A reader can
include current native progress alongside its stored summaries and memories.
`reader.coverage`, such as `{type:"memory",selected:3,total:12}`, describes its
own source scope: total items before branch/content selection, captured selected
items before pagination, and optional `excluded` items removed by source rules.
To change that capture, adjust the relevant content count or use search. Cursor
pages and refs do not recover unselected items.

## Runtime request context

```json
{ "session_id": "ps_...", "view": "runtime", "max_bytes": 24000 }
```

This reads the latest passively captured `context_with_system` event. All
`context` handlers have run, including request-local memory transforms such as
Magic Context's. Later full-context handlers, projections and provider conversion
may still change the request; capture does not establish successful dispatch.

The captured message array supports previews, literal search and reference
expansion. Runtime has no native input-turn grouping: `range` and `leaf_id`
reject. `content` uses the same kind names, but only whole-kind switches are
accepted: booleans for `input`, `system` and `native`, and `0`/`-1` for count
fields. Omitted kinds include all captured content. `selection` and
`omissions.selection` remain null because they describe no native turn selection.
Items use `source.observation_index` and split content/part positions instead of
native entry/prompt IDs. Cursor pages freeze the view and observation metadata.

Available observations contain:

| Field                                                      | Meaning                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `id`, `observed_at`, `owner_generation`                    | Identity, time and owner of the capture.                                                                               |
| `phase`                                                    | `context_with_system_observer`.                                                                                        |
| `input_leaf_id`                                            | Native leaf at capture; also the page's `leaf_id`.                                                                     |
| `current_leaf_id`, `later_committed_entries`, `checked_at` | Active ancestry and intervening commits checked on the first read.                                                     |
| `owner_active`                                             | Whether the capture came from the current live observer. Retained captures report false even if another owner is live. |

Subsequent answers belong to the session view. Idle memory changes are not
recomputed by reading, even when no new native entries exist.

Owned RPCs and companions keep one bounded cleaned capture per runtime. Bridge
retains available owned captures before normal RPC exit without a prior read;
a successful companion runtime read is also retained. The observer has a 32 MiB
accounted capture limit. The separate Bridge retention cache holds the latest
successful capture for at most 16 sessions and approximately 32 MiB. Retention
is memory-only and does not keep writers alive.

Bridge queries a live owner first. If it has no capture yet, a retained success
remains readable as `source:"retained"`, preserving its original ID, time,
generation and input leaf. It is checked against the new owner's active branch,
or the saved branch when no owner exists. No-prompt cold starts therefore leave
previous captures available.

Only successful captures replace retained content. Failed live captures report
unavailable for that read; transport failures or unavailable replies do not erase
an older success. Publication ordering fences delayed captures and retired owners.
Missing, oversized or failed captures and changed branches report
`observation.available:false`, a reason and empty items. Hosts without observers
report `host_observer_unavailable`. Eviction or Bridge restart loses retained
captures; a live observer can still supply its own.

## Native source preservation

Saved v1/v2 histories are normalized in memory by native parsing/migration.
Malformed lines are skipped as in Pi; optional `history` reports
`skipped_malformed_lines` and `unterminated_tail`. Only native writer open repairs
or migrates disk data. Native v1 IDs assigned in memory may differ between fresh
reads; cursor pages retain captured IDs.

## Source content and references

Pages contain `session_id`, `view`, acquisition `source`, captured `leaf_id`,
resolved `selection:{range,content}`, source-ordered `items`, `omissions`, `live`
and `next_cursor`. Runtime and reader-only captures have null native selection.
`presentation:"preview"` identifies navigation rows; `presentation:"source"`
identifies expanded source units. This is an output description, not an input
format option. The MCP envelope represents the same result in JSON text `content` and
`structuredContent`; consume either. `max_bytes` bounds the structured page;
the wire budget accounts for both copies.

Reference expansion returns native source units with entry/message/block positions and `prompt_id`. Message data
uses `message`, assistant blocks use `block`, and large shared fields use linked
`message_metadata` units. Types include prompt, text, thinking, tool call/result,
command, system, custom, native and summary.

- Images become `{type:"image",mime_type:"image/png",data_omitted:true}` without
  base64 or invented links.
- Assistant text/thinking retains `stopReason` on every part. Large error details
  live in shared metadata. Native signatures, response IDs, replay metadata,
  usage/cost and diagnostics are excluded; business arguments/details are not
  recursively stripped by property name.
- Tools retain name, namespace, arguments/errors, paired output and error state.
  Indivisible metadata stays whole or is explicitly marked omitted.
- Saved `nestedCalls` follow their parent tool selection. Small snapshots stay
  whole; larger ones become source-linked `nested_call` units.
  `nested_calls_complete` preserves recorder completeness independently of paging.
  Native `argumentsBytes`, error and unfinished state remain available; missing
  child result bodies are not synthesized.
- Commands retain output and execution state. Every output part repeats
  `exitCode`, `cancelled`, native `truncated` and command/path strings up to 256
  encoded JSON bytes each. Larger fields occur once in linked metadata. Native
  truncation differs from capacity omissions; `!!` records carry
  `in_model_context:false`.
- System sections are segmented before arbitrary-object limits. Summary provenance
  and global/context-prefix content remain available. Later custom/unknown records
  follow their prompt window; custom payloads retain `content`, `customType`,
  `display` and business `details` under the same capacity limits.

A context-hidden user creates an empty boundary; a retained assistant suffix
without its input gets `context_prefix`. Tools are paired before sampling, even
across steering inputs. `pairing` distinguishes paired, unresolved and orphan
units; reused call IDs resolve to the latest preceding unresolved call. Text is
not deduplicated across source positions or custom payload fields.

## Optional input mappings

By default, custom messages follow their existing prompt window; native `custom`
state entries are not conversation messages. Owners can enable exact custom-input
mappings through [module configuration](compatibility.md#owner-configuration).

After native projection, matching `role:"custom"` messages establish input
boundaries before turn/message/tool selection. They become `type:"prompt"` with
their native entry ID as `prompt_id` and `source.read_adapter` identifying the
mapping. Their custom role, type, content and details remain intact. Hidden mapped
inputs use an empty `hidden_input` boundary. Other custom messages/state do not
become inputs. Runtime captures do not apply these mappings.

The external [Intercom module](../integrations/intercom/README.md) maps `intercom_message`;
disabling it and restarting restores ordinary custom-message reading.

## Capacity and continuation

All browse, search and reference pages move forward in source order. Session
browsing tries to keep each input turn on one page. A turn that fits an empty
page moves to the next page when the current page has insufficient space;
a turn too large for an empty page is shortened and, when necessary, split
across pages. Empty pages are not emitted to wait for a larger budget.

Within a turn, the latest selected assistant body receives priority over earlier
reply previews, while input and selected thinking retain readable space. Budget
priority never moves an item ahead of its source position. A very long latest
reply becomes a larger marked preview with a ref; it does not monopolize ordinary
cursor pages with its full body. The latest reply need not appear on the first
page of a multi-turn read; use `range:{recent:1}` to focus on the current turn.

`next_cursor` continues the same capture. `omissions.selection.turns` counts
excluded input turns; per-kind counts describe records excluded by content or
range selection. Assistant/thinking counts refer to messages, not content blocks.
`omissions.capacity.remaining_units` counts items available through continuation;
`previous_units` counts items on preceding pages. Reader coverage describes its
own source scope separately.

Small blocks stay whole. Long prose splits at paragraphs/lines, then whitespace
or Unicode code-point boundaries. Parts retain source/tool links and may carry
`part`; message parts preserve `content_index`. Items are independently readable
objects, not JSON fragments. Content counts refer to messages or logical tool operations, not paragraphs or
these transport fragments.

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

The cache retains detached sanitized units, at most 16 snapshots and approximately
32 MiB of accounted memory. Excess selected data returns `READ_SNAPSHOT_TOO_LARGE`
without narrowing the requested content. References and cursors are issued only
after successful caching. Browse/search results with refs are cached even when
they fit on one page; a complete expansion without further refs needs no cache entry. Batch pins needed snapshots
through assembly; temporary pressure returns `READ_CACHE_BUSY`.

There is no inactivity expiry. LRU/capacity eviction or Bridge restart produces
`STALE_CURSOR` or `STALE_READ_REFERENCE`; start a fresh read/search. References
are bounded capture handles, not permanent session URLs. Appends, owner exit, release and replacement
otherwise leave the frozen capture intact. Every continuation and expansion rechecks permission and native identity,
including header cwd; identity changes invalidate access to the capture.

## Live output and runtime extension events

`live` is a separate bounded, transient and incomplete observation, outside cursor
history. It uses the same image/signature sanitization and readable units. Native
text/thinking deltas and cumulative message events feed it; tool-result streams
and bash chunks are not assistant text. Owned projection and preview are captured
together, keeping later-prompt output out of an earlier capture.

The observer keeps the newest tail under 65,536 UTF-16 units, including per-block
overhead. Oversized text/thinking trims at Unicode boundaries and reports truncation;
a larger byte budget can expose more of that tail. Cursors and explicit-leaf reads
have no moving preview. `available:false` carries a reason; an empty item list means
no unfinished assistant text was observed, not that all work is idle. Final commits
remain authoritative.

`runtime_events` contains bounded, generation-scoped transient extension errors
and notifications from owned RPCs. It is separate from history and completion
notifications.

## Read costs and current components

Saved first reads parse history and discard image bytes per record before
projection. Unrelated dangling parents do not invalidate a usable branch;
duplicate IDs, invalid entries and traversed cycles reject. Owners select and
sanitize before transfer, so read IPC limits apply to cleaned snapshots rather
than unselected history. Continuations use only the cache, without fetching
entries or computing history fingerprints.

Fork uses a separate [raw snapshot contract](runtime.md#read-and-fork-boundaries).
Read never falls back to it. Bridge and companion/host read contracts must match;
missing/mismatched contracts return `OWNER_READ_REFRESH_REQUIRED` with refresh
guidance. Update the running components at a safe boundary; changing read arguments
or refreshing the client's schema cannot update an owner.
