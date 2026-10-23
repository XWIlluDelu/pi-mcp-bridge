# Reading a Pi session

`read` uses a matching configured session reader based on the target's live or
persisted extension evidence, otherwise Pi's native projection. Only explicit
`view:"native"` forces native reading; selection parameters go to the selected
reader. [Module routing](compatibility.md#session-specific-read-routing) defines
that contract.

Native `buildSessionProjection` determines branch ancestry, compaction checkpoints
and context edits. Bridge pairs tools and applies selectors before sanitizing and
segmenting records. Reading never starts Pi, calls a model, reruns context hooks
or writes history. The result is a readable view, not a lossless export or final
provider payload.

## Request

```json
{ "session_id": "ps_...", "max_bytes": 4096 }
```

Continue with the returned cursor; the byte budget may change:

```json
{ "cursor": "<next_cursor>", "max_bytes": 12000 }
```

| Argument     | Meaning                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------- |
| `session_id` | Required initially; optional with a cursor.                                                                           |
| `view`       | Omit for automatic routing; `native` forces projection, `observed` reads a capture. Continuations inherit the source. |
| `preset`     | Native default `latest`; alternatives `recent` and `full`. Omitted continuation fields inherit.                       |
| `select`     | Overrides for the eight selectors below.                                                                              |
| `max_bytes`  | UTF-8 limit for the whole structured page: default 24000, range 4096–65536.                                           |
| `cursor`     | Opaque backward continuation of a captured snapshot.                                                                  |
| `leaf_id`    | Optional native leaf; explicit `null` means the empty root.                                                           |

A continuation's explicit preset plus selectors must match all eight captured
values. Without a preset, only explicitly supplied selectors are compared.
Explicit view/session/leaf values must also match; conflicts return `STALE_CURSOR`.
Defaults are applied only after deciding what to inherit.

Every page uses a new [permission snapshot](configuration.md#request-permission-snapshots)
and validates current canonical file/native identity. A cursor grants no access
and cannot cross Bridge instances.

Adapted results use `view:"adapted"`, `reader.id` and `source.reader_index` locators.
Their native selection counts are null. They share sanitization, byte budgets and
frozen pagination with other views.

## Observed request context

```json
{ "session_id": "ps_...", "view": "observed", "max_bytes": 24000 }
```

This reads the latest passively captured `context_with_system` event. All
`context` handlers have run, including request-local memory transforms such as
Magic Context's. Later full-context handlers, projections and provider conversion
may still change the request; capture does not establish successful dispatch.

The whole captured message array is pageable. Native `preset`, `select` and
`leaf_id` arguments reject; `selection` and `omissions.selection` are null.
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

Subsequent answers belong to the native view. Idle memory changes are not
recomputed by reading, even when no new native entries exist.

Owned RPCs and companions keep one bounded cleaned capture per runtime. Bridge
retains available owned captures before normal RPC exit without a prior read;
a successful companion observed read is also retained. The observer has a 32 MiB
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

## Native selection

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

Presets supply defaults; explicit `select` fields replace individual values:

| Selector           | `latest` (default) | `recent` | `full` |
| ------------------ | ------------------ | -------- | ------ |
| `system`           | 0                  | 0        | -1     |
| `summary`          | 0                  | 1        | -1     |
| `recent_prompts`   | 1                  | 3        | -1     |
| `earliest_prompts` | 0                  | 0        | -1     |
| `text`             | -1                 | -1       | -1     |
| `thinking`         | 2                  | 3        | -1     |
| `tools`            | 0                  | 0        | -1     |
| `commands`         | 0                  | 0        | -1     |

`latest` focuses on the last input and assistant text/thinking; `recent` adds
active summaries and more prompts. Omitted system records count in
`omissions.selection.system`. Use `select:{system:-1}` to include them without
switching to full. This selector does not hide custom messages or affect observed
captures.

When system records are selected, `tools:0` removes `toolsAdded`/`toolsRemoved`
declarations and declaration-only records, preserving instructions and section
updates/removals. Declarations are global, not counted as per-prompt tool units.

For the latest prompt plus the earliest input and first/last two tool units:

```json
{ "session_id": "ps_...", "select": { "tools": 2, "earliest_prompts": 1 } }
```

Overrides leave other preset values intact. With `full`, `recent_prompts:1`
still selects every prompt because `earliest_prompts` remains `-1`; set it to `0`
for recent-only selection. With `latest`, changing only `recent_prompts:3` retains
its summary and thinking defaults rather than selecting `recent`.

Saved v1/v2 histories are normalized in memory by native parsing/migration.
Malformed lines are skipped as in Pi; optional `history` reports
`skipped_malformed_lines` and `unterminated_tail`. Only native writer open repairs
or migrates disk data. Native v1 IDs assigned in memory may differ between fresh
reads; cursor pages retain captured IDs.

## Readable content

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
become inputs. Observed captures do not apply these mappings.

The [Intercom module](compatibility.md#input-mapping) maps `intercom_message`;
disabling it and restarting restores ordinary custom-message reading.

## Capacity and continuation

The first page holds the newest selected units that fit, in chronological order;
`next_cursor` moves backward. `omissions.selection` counts excluded native logical
records. `omissions.capacity.earlier_units` and `later_units` locate a page within
the capture; later units are already-covered newer content.

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
without narrowing selectors. Cursors are issued only after successful caching;
a complete one-page result needs no cache entry. Batch pins needed snapshots
through assembly; temporary pressure returns `READ_CACHE_BUSY`.

There is no inactivity expiry. LRU/capacity eviction or Bridge restart produces
`STALE_CURSOR`; start a fresh read. Appends, owner exit, release and replacement
otherwise leave the frozen capture intact. Every continuation rechecks permission
and native identity, including header cwd; identity changes invalidate the cursor.

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
