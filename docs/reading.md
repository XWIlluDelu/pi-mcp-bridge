# Reading a Pi session

Start with `read({session_id})` to understand the current task. The default brief
result includes readable task/result excerpts, active summaries and compact tool
activity, with references for deeper reading. Use `search` to find evidence beyond
those excerpts, then pass returned references to `read`.

Both tools use a matching explicitly enabled session reader, otherwise Pi's native
projection. `view:"session"` forces **Session Context**: the effective native
context at a leaf. `view:"runtime"` selects **Runtime Context**: a captured request
stage. Reader results identify `reader.id` and use `view:"adapted"`; callers do not
need a plugin name to select the default path. [Module routing](compatibility.md#session-specific-read-routing)
defines activation and content contracts.

Native `buildSessionProjection` determines branch ancestry, compaction checkpoints
and context edits. `full` means all effective context at that leaf, including active
summaries and retained messages; it does not mean the entire raw session log.
Reading and searching never start Pi, call a model, rerun context hooks or write
history. Results are sanitized readable content, not lossless exports or final
provider payloads.

## Browse, find and expand

Read a useful overview:

```json
{ "session_id": "ps_...", "max_bytes": 4096 }
```

If more task background is needed, use `preset:"recent"`. To locate a particular
decision or tool result, call the separate `search` tool:

```json
{ "session_id": "ps_...", "query": "retry policy" }
```

Search is case-insensitive literal matching over the selected reader's full
effective content, including text beyond brief previews and earlier pages. It
searches one authorized session, not other sessions, hidden raw history, or content
that the source never captured. `types` optionally filters returned item kinds.
Search returns `query`, `matches`, snippets and refs. Continue its result pages
with `read({cursor})`.

Expand references from one captured result with `read`:

```json
{ "refs": ["<item.ref>", "<related.ref>"], "max_bytes": 12000 }
```

Ordinary references return their frozen, sanitized source content. Up to eight refs
from the same capture can be expanded together; duplicate refs are expanded once.
A `related` link with `relation:"operation"` opens a recorded nested tool operation.
A `source_context` link opens a fresh Session Context read at an identified
historical leaf; it gives context at that boundary, not an exact reconstruction of
the extension's source range. Open a source-context reference by itself.

Continue any result with its cursor; the byte budget may change:

```json
{ "cursor": "<next_cursor>", "max_bytes": 12000 }
```

To read selected source units directly, use `detail:"full"`. This controls the
amount of content per selected item; `preset:"full"` controls the selected range.

```json
{ "session_id": "ps_...", "preset": "recent", "detail": "full" }
```

| Read argument | Meaning                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `session_id`  | Required for a fresh browse; optional with cursor or refs.                                           |
| `view`        | Omit for automatic routing; `session` forces native projection, `runtime` reads a capture.           |
| `preset`      | Session default `latest`; `recent` adds more prompts; `full` selects all effective content.          |
| `select`      | Overrides for the eight Session Context selectors below.                                             |
| `detail`      | Default `brief` returns excerpts and refs; `full` returns selected source units.                     |
| `types`       | Optional content kinds from item `type` values; applies to brief browsing.                           |
| `refs`        | One to eight references from one capture. Only optional `session_id` and `max_bytes` accompany refs. |
| `cursor`      | Opaque continuation of a captured result.                                                            |
| `max_bytes`   | UTF-8 limit for the whole structured page: default 24000, range 4096–65536.                          |
| `leaf_id`     | Optional native leaf; explicit `null` means the empty root.                                          |

Search accepts `session_id`, required nonempty `query` (up to 2048 characters),
optional `view`, `types`, `leaf_id` and `max_bytes`. Runtime search rejects
`leaf_id`. It selects the full effective source independently of earlier browsing
selectors; this is how to find an item omitted from a `latest` overview.

A continuation inherits the capture's source, detail, types, selection and leaf.
Explicit conflicting values return `STALE_CURSOR`. When supplying a preset, its
resolved selectors must all match; without a preset, only supplied selectors are
compared. Cursor-only continuation is the simplest form.

Every page and reference expansion uses a new
[permission snapshot](configuration.md#request-permission-snapshots) and validates
canonical file/native identity. Neither a cursor nor a reference grants access.
They cannot cross Bridge instances.

## Brief content

Brief items have `type`, `text`, `ref`, source locators and optional `title` and
`related` references. Session and adapted browsing put the latest selected input
and its latest assistant reply first, followed by summaries and memories, then
remaining activity from newest to oldest. These are selected source excerpts;
the reader does not generate a new task summary. Large previews share the page
budget so a long input can appear alongside its answer.

All selected text blocks from one assistant message share one brief item and ref.
Explicit text selectors still count blocks; grouping does not restore unselected
content. Search results include `matches`; supplied `types` filters are echoed in
the result. Text excerpts can be shorter than their source; expanding the ref
retrieves its captured content.

Logical tool calls and results are grouped before previewing. Tool previews name
the tool and common target fields, indicate recorded result/error status, and show
nested operation counts and failure clues. Nested-call references expose only
what native history recorded; missing child output is not synthesized.

Reader items retain their own kinds, stable-within-capture item identity and
provenance. Readers can supply short previews and related items while retaining
longer text for search and expansion. Current native task/progress content can be
included alongside extension memories through the shared reader contract.

A reader may return `reader.coverage` rows such as
`{type:"memory",selected:3,total:12}`. `total` counts items in its declared source
scope before branch or preset selection; `selected` counts captured items before
pagination or search-result filtering. Optional `excluded` counts items from that
total removed by selection rules, such as other-branch summaries.
They explain a small default overview without implying that every stored extension
record was read. Cursor pages and refs cannot recover unselected items: request
`recent`, `full`, or use search to locate evidence in the reader's full supported
source. Native `omissions.selection`, reader coverage and page capacity counts
describe different boundaries.

## Runtime request context

```json
{ "session_id": "ps_...", "view": "runtime", "max_bytes": 24000 }
```

This reads the latest passively captured `context_with_system` event. All
`context` handlers have run, including request-local memory transforms such as
Magic Context's. Later full-context handlers, projections and provider conversion
may still change the request; capture does not establish successful dispatch.

The captured message array supports brief previews, literal search, reference
expansion and full-content pagination. Native `preset`, `select` and `leaf_id`
arguments reject; `selection` and `omissions.selection` are null.
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

## Session Context selection

| Selector           | Counting and selection                                                                                                      |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `system`           | `0` omits native instructions/sections; `-1` includes them in native order. Tool declarations also require nonzero `tools`. |
| `summary`          | `0` omits; `1` or `-1` includes all active summaries at native positions.                                                   |
| `recent_prompts`   | Last N inputs (native users or explicitly mapped custom messages), or all with `-1`.                                        |
| `earliest_prompts` | First N inputs, or all with `-1`.                                                                                           |
| `text`             | Per selected prompt, first N and last N assistant text blocks.                                                              |
| `thinking`         | Per selected prompt, first N and last N thinking blocks.                                                                    |
| `tools`            | Per selected prompt, first N and last N logical units: call with paired result, unresolved call or orphan result.           |
| `commands`         | Last N native `bashExecution` messages, independently of prompts.                                                           |

Counts accept nonnegative safe integers or `-1` for all; `0` selects none.
`system` accepts only `0/-1` and `summary` only `0/1/-1`. First/last overlap is
included once, selecting at most 2N units per prompt. Identical content at
different source positions remains distinct.

Presets supply the following defaults in both detail modes. Explicit `select`
fields replace individual values; `detail` changes presentation, not selection:

| Selector           | `latest` (default) | `recent` | `full` |
| ------------------ | ------------------ | -------- | ------ |
| `system`           | 0                  | 0        | -1     |
| `summary`          | 1                  | 1        | -1     |
| `recent_prompts`   | 1                  | 3        | -1     |
| `earliest_prompts` | 0                  | 0        | 0      |
| `text`             | -1                 | -1       | -1     |
| `thinking`         | 0                  | 0        | -1     |
| `tools`            | 2                  | 2        | -1     |
| `commands`         | 0                  | 0        | -1     |

`latest` and `recent` include active summaries, omit thinking, and select the
first/last two tool units per selected prompt. `preset:"full"` selects all effective
content in either detail mode.

`latest` focuses on the last input; `recent` adds more prompts. Omitted system records count in
`omissions.selection.system`. Use `select:{system:-1}` to include them without
switching to full. This selector does not hide custom messages or affect runtime
captures.

When system records are selected, `tools:0` removes `toolsAdded`/`toolsRemoved`
declarations and declaration-only records, preserving instructions and section
updates/removals. Declarations are global, not counted as per-prompt tool units.

For the latest prompt plus the earliest input and first/last two tool units:

```json
{ "session_id": "ps_...", "select": { "tools": 2, "earliest_prompts": 1 } }
```

Overrides leave other preset values intact. All presets use
`earliest_prompts:0`, so `recent_prompts:1` narrows even `full` to the latest
prompt window. System, summary and command selectors remain independent. With
`latest`, changing only `recent_prompts:3` retains its other defaults rather than
selecting `recent`.

Saved v1/v2 histories are normalized in memory by native parsing/migration.
Malformed lines are skipped as in Pi; optional `history` reports
`skipped_malformed_lines` and `unterminated_tail`. Only native writer open repairs
or migrates disk data. Native v1 IDs assigned in memory may differ between fresh
reads; cursor pages retain captured IDs.

## Full readable content

Pages contain `session_id`, `view`, acquisition `source`, captured `leaf_id`,
resolved `selection`, chronological `items`, `omissions`, `live` and `next_cursor`.
The MCP envelope represents the same result in JSON text `content` and
`structuredContent`; consume either. `max_bytes` bounds the structured page;
the wire budget accounts for both copies.

Native units retain entry/message/block positions and `prompt_id`. Message data
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
boundaries before prompt/block/tool selection. They become `type:"prompt"` with
their native entry ID as `prompt_id` and `source.read_adapter` identifying the
mapping. Their custom role, type, content and details remain intact. Hidden mapped
inputs use an empty `hidden_input` boundary. Other custom messages/state do not
become inputs. Runtime captures do not apply these mappings.

The external [Intercom module](../integrations/intercom/README.md) maps `intercom_message`;
disabling it and restarting restores ordinary custom-message reading.

## Capacity and continuation

Brief Session/adapted pages follow the task-first navigation order above.
Full-content, Runtime and search pages start with the newest selected source
items or units that fit, in source order, then move backward. In either case,
`next_cursor` continues the same frozen capture. `omissions.selection` counts
excluded native logical records. `omissions.capacity.remaining_units` counts
items available through continuation; `previous_units` counts items on preceding
pages. Neither count means that the source contains no other unselected content.

Small blocks stay whole. Long prose splits at paragraphs/lines, then whitespace
or Unicode code-point boundaries. Parts retain source/tool links and may carry
`part`; message parts preserve `content_index`. Items are independently readable
objects, not JSON fragments. Selectors count native prompts/blocks/tools, not
paragraphs.

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
without narrowing selectors. References and cursors are issued only after successful caching. Brief/search
results with refs are cached even when they fit on one page; a complete full-detail
page without refs needs no cache entry. Batch pins needed snapshots
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
guidance. Update the running components at a safe boundary; changing selectors
or refreshing the client's schema cannot update an owner.
