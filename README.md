# Pi MCP Bridge

A local, vendor-independent MCP server for saved Pi sessions, Bridge-owned RPC
workers and cooperating ordinary Pi TUI/RPC hosts. It exposes `list`, `read`,
`send`, `stop`, `bash`, `create`, `delete` and ordered `batch` over stdio
or authenticated loopback Streamable HTTP.

Integration uses public Pi APIs and private Unix sockets, independently of any
host project. Cooperative process identity/attachment currently requires Linux.
Native tools, models, settings, extensions and existing authentication remain
Pi's responsibility.

## Install and try

Requires Node >=22.19.0; regression checks use Node 26.10.0 and Pi 1.1.0.

```sh
npm ci --ignore-scripts
npm test
node research/init-demo.mjs
node research/demo-client.mjs
node src/server.mjs "$PWD/demo/owner-config.json"
```

The demo uses disposable synthetic sessions and an explicitly isolated,
tool-disabled Pi profile, without real model credentials. Initialization preserves
existing demo configuration; ensure reused configs explicitly select isolation.
The final command speaks MCP on stdin/stdout. Example client configuration:

```json
{
  "command": "node",
  "args": ["/absolute/path/pi-mcp-bridge/src/server.mjs",
           "/absolute/path/pi-mcp-bridge/demo/owner-config.json"]
}
```

For independently running Bridge access, see [loopback HTTP](deploy/HTTP.md).
The [stdio service kit](deploy/README.md) requires a foreground client to own
the protocol pipe and await shutdown. Both are owner-installed;
closing terminals is distinct from keeping the access service running.

## Owner configuration

`sessionRoots` are private Pi JSONL storage directories. `folders` are separately
configured project working directories. Owner configuration assigns the fixed
caller principal, runtime options and grants:

```json
[
  {"folder":"/projects/demo","read":true,"send":true,"new_session":true},
  {"folder":"/projects/demo/child","read":false},
  {"session_id":"ps_returned_opaque_id","send":false},
  {"session_id":"ps_returned_opaque_id","send":null}
]
```

| Grant | Controls |
| --- | --- |
| `read` | Transcript, metadata and runtime observations |
| `send` | Model-mediated prompts |
| `command` | Remote stop; also requires read to return withdrawn text |
| `bash` | Direct native shell commands and their own results |
| `delete` | Recoverable removal of a session file |
| `new_session` | Creation within an exposed folder; folder scope only |

Each grant is independent and defaults to deny. An explicit session rule wins,
then the nearest project rule. Later entries replace the same permission at the
same scope; `null` inherits. Project paths are canonicalized. Create-only folders
and bash-only callers do not imply prompt access; stop does not grant shell execution.

Entrypoints reload grants before requests. Other configuration changes require
restart (`CONFIG_RESTART_REQUIRED`). An invalid config blocks new requests;
already dispatched work may finish. Content/output replay checks current access.

This is API authorization, not an OS sandbox. Owner-authorized shell/model tools
run with Pi's host privileges. Session-operation arguments do not override caller identity, grants, storage
roots or runtime configuration; these come from the owner file. Protect the owner file and
state directory from untrusted local code, and authenticate remote transport.

### Native runtime defaults

Without overrides, cold resume inherits the service environment and uses Pi's
normal agent directory (`PI_CODING_AGENT_DIR`, otherwise `~/.pi/agent`), settings,
saved model/thinking selection, tools, packages, resources and authentication.
Service and interactive-shell environments may differ.

```json
{
  "piRuntime": {"tools":["read","bash"]},
  "piArgs": ["--thinking","high"]
}
```

Omitted/null `tools` and `inheritEnv` retain native defaults. `tools:[]` disables
tools; an explicit environment list filters inheritance while retaining PATH.
`agentDir` selects another profile; filtering environment alone does not isolate
file-based credentials. CLI flags can append extensions or toggle resources.
Tests and demos isolate explicitly; standard startup uses normal native defaults.

### Local Pi controls and attachment

Load the companion and permission menu using the same owner configuration and
private IPC directory as Bridge. Close/release an existing writer before a direct
`--session` launch; for a busy Bridge-owned session, use the idle join below.

```sh
cd /absolute/path/to/authorized-project
PI_MCP_OWNER_CONFIG=/absolute/path/to/owner.json \
PI_MCP_ATTACH_DIR=/absolute/path/to/private-ipc \
  pi --session /absolute/path/inside/sessionRoots/session.jsonl \
  -e /absolute/path/pi-mcp-bridge/src/attach-extension.mjs \
  -e /absolute/path/pi-mcp-bridge/src/owner-permissions-extension.mjs
```

Ordinary RPC uses the same recipe with `--mode rpc`; its caller retains
stdin/stdout. The companion uses a separate local socket without spawning a second writer.
Pi retains its normal profile and credentials in-place.

**Ctrl+Alt+P** changes existing session/project grants via Allow, Block or Inherit.
It does not add roots/projects/callers or change models. The owner-local menu is a
TUI shortcut rather than a remotely callable slash command. Edits atomically
preserve unrelated config and refuse detected concurrent changes. A crashed
permission editor may leave a lock requiring owner-confirmed cleanup.

To join a Bridge-owned session, launch ordinary Pi on a fresh/different session
with the companion and use `/bridge-join ps_…`. It waits for admitted work,
confirms normal child exit, then switches to the latest history. **Ctrl+Alt+J**
cancels the wait. Initial `pi --session <owned-file>` is different: Pi opens that
file before loading extensions. See [handoff and recovery](docs/runtime-handoff.md).

### Supported live routes

| Runtime | read/send | Full stop | Native bash |
| --- | --- | --- | --- |
| Bridge-owned RPC | Yes | Yes | Yes |
| Generic SDK/RPC host | Yes | Optional public callback | Optional public callback |
| Ordinary companion | Yes | `STOP_UNSUPPORTED` | `BASH_UNSUPPORTED` |

The companion can recover TUI queued text, but public extension context lacks
standalone bash cancellation/execution. `pi.exec` is not substituted for native
history/Escape behavior. Generic host bindings use the existing owner's public
session/client; see [host adapter](docs/host-adapter.md).

Claims bind canonical file, native ID, process identity and generation. Reload or
session replacement retires the old endpoint. A live unavailable owner blocks a
fallback writer; Bridge close disconnects external hosts without terminating them.
Unregistered writers do not participate in this cooperative registry. Session files
must be canonical regular files with one hard link. Owner-local release persists
a no-cold-reacquire restriction until explicit reset; valid attachments remain usable.
Details and observed startup/preflight limits are in the handoff document.

## Tools

### list

Returns discoverable opaque session IDs. Readable rows also include bounded
native title, cwd, leaf and effective permissions; unreadable rows contain only
the ID. Query searches readable title/cwd, never hidden metadata. Offset/limit
paginate rows; without query, only that page's readable histories are parsed.
Query matches are filtered from all readable histories before pagination.
Creation-capable folders appear separately.

### read

`session_id` is required. Default view is `context`:

| View | Content |
| --- | --- |
| `context` | Native effective projection for the selected leaf, including compaction and context edits |
| `overview` | Bounded extractive source locators, excerpts, checkpoints and tool observations |
| `raw` | Original stored entries, including replaced/hidden originals |
| `summary` | Visible compaction/branch-summary records |
| `status` | Live state/settlement observation, without transcript retrieval |

Permission is checked before loading content or contacting the runtime. Saved
sessions use their persisted resume leaf; live reads use the owner's leaf.
`leaf_id` selects historical ancestry; `raw` is stored-entry order instead.
`entry_id` selects source records, `query` filters serialized selected records,
and `since` applies only to raw. Overview is extractive; its manifest identifies
sampled and omitted ranges with source locators.

Regular pages use `limit` (1–50) and `max_chars` (256–32768, default 12000).
Oversized entries return `json_fragment`, `char_offset`, `total_chars`; concatenate
fragments before JSON decoding. Follow `next_cursor` with the same selection,
changing the budget if desired. Changed history/selection yields `STALE_CURSOR`.
Budgets count serialized item content; envelope/cursor metadata adds overhead.

#### Precise decoded text

Skip opaque blocks and read an individual projected text block:

```json
{
  "session_id":"ps_...",
  "view":"context",
  "entry_id":"native-entry-id",
  "message_index":0,
  "block_index":1,
  "text_offset":0,
  "max_chars":512
}
```

`message_index` selects a message within that entry's projection. String content
needs no block index; array content needs an exact text block. For a projected
system section, replace `block_index` with:

```json
{"field":"sections","section":"project_context"}
```

Only an own string-valued section is readable. Empty content remains empty;
sections are not flattened or merged with later system updates. Native hidden/
replacement semantics apply. Compaction entries may contain a short summary and
a richer `systemMessage`. These are saved checkpoints, distinct from current
injected memory or the final provider payload. Reads project existing records
without invoking context hooks or models.

The response uses `format:"projected_text"`, `offset_unit:"utf16_code_units"`
and one item containing text, offset, total units and field/block/section provenance.
Offsets address decoded JavaScript string units; pages do not split surrogate pairs.
Continue the cursor with identical selectors, including the initial offset.
Precise selection is context-only and excludes `query`/`since`.
Invalid/missing/nontext selection gives an explicit error, not raw fallback.
An owner ignoring the selector returns `OWNER_READ_REFRESH_REQUIRED`.

**Existing JSON offsets/cursors are unchanged.** Overview excerpt offsets and
ordinary fragment offsets address serialized JSON, not decoded text. Text cursors
also bind resolved leaf/revision. Increase the budget on `TEXT_BUDGET_TOO_SMALL`;
use an independently authorized raw request for original evidence.

#### Status and wait

`read({session_id,view:"status"})` never starts Pi or retrieves entries.
For a subsequent session-wide settlement, capture `activity.settlement` before
sending, then request:

```json
{
  "session_id":"ps_...",
  "view":"status",
  "after_settlement":{"generation":"observed-generation","sequence":0},
  "wait_ms":10000
}
```

Wait is 0–10000 ms. Outcomes distinguish `settled`, `timeout`,
`generation_changed`, `unavailable` and `not_requested`. Generation replacement
resets sequence. Settlement is not exclusive request completion or current idle.
An initial observation is always taken; polling is bounded by wait_ms, while
in-flight state/ownership I/O can add its normal overhead (state timeout 5 s).
Permissions are rechecked before returning. Stdio cancellation stops the wait;
stateless HTTP requires disconnecting the original request rather than sending
a separate cancellation notification.

### send

Use stable `request_id`, `session_id`, `text` and optional mode:

- `native`: plain Pi prompt; busy prompts may be rejected.
- `idle_only`: resolve/resume, then skip if streaming/compacting.
- `steer`: starts idle, steers busy.
- `queue`: starts idle, follows up busy.

Owned RPC reports `started|queued|handled` admission, not completed output.
Companion sends report `unknown / PI_ACCEPTANCE_UNOBSERVABLE` because the public
send API returns void. Idle checks are observational rather than atomic admission gates.
`timeout_ms` bounds admission ACK wait rather than model execution or the whole request.

Repeat the ID/arguments to replay, or omit text to retrieve the receipt.
Different text/mode/operation/target conflicts. Unknown never triggers automatic
resend; a verified late ACK may update it. An unresolved owned prompt ACK blocks
another prompt (`PROMPT_ADMISSION_PENDING`) until that ACK or exact child exit.
The session-wide settlement event cannot clear that fence.

### stop and bash

[`stop`](docs/stop.md) cancels current native execution, withdraws queued inputs,
and returns complete native-joined text while keeping process/session/ownership.
It is live-only and requires `command` plus `read`. Follow the same request ID's
cursor until `withdrawn_complete`; replay never cancels a later run.

[`bash`](docs/bash.md) is native `!command`, not a model prompt. Separate
`bash` permission defaults to deny. It can cold-resume a permitted saved session;
results retain native exit code, cancellation, truncation and spill-file facts.
Replay/output pagination use the same ID. ACK timeout does not kill the command.
Both tools are independent operations, not batch items.

### create and delete

`create` requires `folder_id`, `request_id`, `new_session` and a usable project
cwd. It durably creates an empty v3 session without a model call or implicit prompt.

`delete` requires independent permission. It confirms owned runtime exit before
atomically moving only the JSONL to adjacent private `.pi-mcp-trash`, with durable
restore metadata and a state-directory index. Project files remain unchanged.
External owners must support safe release/exit; socket closure is not exit proof.
RPC companion deletion is unsupported. The same ID replays the restore token.

To recover with Bridge stopped, inspect original and trash paths recorded in the state
directory index or `.pi-mcp-trash`, and restore the JSONL to its recorded original path
without overwriting existing files. Path and native identity determine public ID and grants.
Legacy state-directory trash may lack metadata; identify its original path before
restoring. Permanent deletion and remote restore are outside the remote API.

### batch and receipts

`batch` accepts 1–10 ordered `read|send|create|delete` operations with individual
arguments. Preflight rejects structural/request-ID conflicts. Read-before-delete
is valid; delete-before-read and same-session send/delete are contradictions.
Results stay in input order with per-item errors. Reads are captured once and
resized without rereading after later mutations; 32768 serialized characters
bound the whole response. `BATCH_RESULT_OMITTED` explicitly directs a separate
read or same-ID mutation replay. This is not a transaction.

Once admitted, later batch mutations continue after HTTP disconnect; status
wait cancellation may produce an item error without stopping the batch.

Mutation receipts persist before dispatch and survive restart. Repeated IDs do
not execute again; persistence errors are surfaced. Receipt uncertainty is not
exactly-once delivery or tool rollback. Keep local receipts/recovery output private.

## Verification, research and recovery

`npm test` exercises public Pi/MCP APIs with disposable offline providers,
including actual RPC, TUI, host IPC, permissions, receipts and pagination.
Reusable long-session methods are in [research notes](research/long-session-reading.md).
Generated transcripts, deployment evidence and credentials belong in ignored
`.local/`; public fixtures use synthetic content.

Optional real-provider research requires explicit consent, destination
acknowledgement and existing environment credentials:

```sh
PI_REAL_TEST=1 \
PI_REAL_BASE_URL=https://example.invalid/v1 \
PI_REAL_ACK_DESTINATION=https://example.invalid/v1 \
OPENAI_BASE_URL=https://example.invalid/v1 \
PI_REAL_MODEL=your-model \
node research/real-client.mjs
```

Replace the invalid example endpoint deliberately; `OPENAI_API_KEY` is supplied
through protected environment, not the command/config. The harness uses a
tool-disabled disposable profile. `PI_REAL_REVIEW=1` reviews public HEAD source;
`PI_REAL_REVIEW_ONLY=1` skips lifecycle prompts. Review feedback is untrusted and stays local.

Recovery: confirm relevant old processes have stopped before owner-managed
cleanup of a stale Bridge, registry or permission-editor lock. Live or
transitioning owners continue to block fallback.
Restarting Bridge does not clear a deliberate no-cold-reacquire marker. Use the
[owner-local reset procedure](docs/runtime-handoff.md#explicit-return-to-cold-resume)
only after the local writer closes. Client schema refresh and host adapter reload
are separate: a Bridge restart cannot update an external owner's cached module.

Optional `PI_MCP_LOG=1` enables content-free stderr timing/correlation diagnostics:
[boundaries and local/remote comparison](deploy/diagnostics.md).
