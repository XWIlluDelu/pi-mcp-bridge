# Pi session MCP bridge prototype

A local, vendor-independent, standard MCP **stdio** server exposing exactly five tools: `list`, `read`, `send`, `create`, `delete`.

This is a working isolated prototype, not a production service or a connector installed into dot. It handles bridge-owned Pi processes and saved sessions; attaching an independently running TUI is still unfinished.

## Quick start

Requires Node >=22.19.0 (tested on 24.19.0).

```sh
npm ci --ignore-scripts
npm test
node research/init-demo.mjs
node research/demo-client.mjs  # runnable end-to-end synthetic demo
node src/server.mjs "$PWD/demo/owner-config.json"
```

The last command speaks MCP on stdin/stdout. Use any standard MCP stdio client; stdout contains only protocol messages. `init-demo` prints the absolute launch command and preserves an existing config. The demo uses an explicit synthetic provider, never real model credentials or a paid model. Its extension blocks HTTP fetch. An MCP client's server configuration can point to:

```json
{
  "command": "node",
  "args": ["/absolute/path/pi-session-bridge/src/server.mjs", "/absolute/path/pi-session-bridge/demo/owner-config.json"]
}
```

No native dot MCP connector has been configured or verified. The checked integration test uses the official MCP SDK client against the actual child server process.

## Owner configuration and trust boundary

`demo/owner-config.json` is generated locally. `sessionRoots` are private Pi JSONL storage directories; `folders` are project working directories, independent of storage. Only owner configuration assigns policy and caller identity. No MCP tool can set permissions, choose a filesystem path, change the caller, launch arbitrary programs, or edit runtime options.

Example grants:

```json
[
  {"folder":"/projects/demo", "read":true, "send":true, "delete":false, "new_session":true},
  {"folder":"/projects/demo/child", "read":false},
  {"session_id":"ps_returned_opaque_id", "send":false},
  {"session_id":"ps_returned_opaque_id", "send":null}
]
```

For each independent permission, explicit session setting wins, then the nearest explicit project-folder setting, then deny. Later entries replace that permission at the same scope; `null` means unset/inherit. Project cwd is canonicalized before matching, and configured exposed folders must be canonical existing directories. `new_session` is folder-only. `new_session:true` with `send:false` is normal and creates no warning or implicit permission grant.

The process has one fixed principal and one state-directory lock; overlapping session roots/state directories are rejected. Configuration is loaded on startup; edit owner configuration and restart to change it. This is an API authorization layer, **not an OS sandbox**. Keep owner configuration, receipts and state inaccessible to untrusted Pi tools. The launcher disables tools, automatic extensions, skills, themes and prompt templates by default. Its child environment deliberately does not inherit host provider keys/subscriptions and uses an isolated Pi home with startup networking disabled (PI_OFFLINE=1). Explicit owner `piArgs` can enable a provider or an extension. Never expose the bridge to an untrusted caller through unauthenticated network transport.

Use **exclusively owned test session storage**. The bridge cannot detect or safely attach every independently running Pi TUI; do not point it at live shared user session storage. It does not touch project files during create/delete, but a separately authorized future tool-enabled Pi runtime could.

## Tool behavior

### list

Returns bounded session rows and opaque folder IDs available for creation. An unreadable session returns only `{session_id}`. No title, cwd, status, permissions or content is exposed for that row. A query excludes unreadable sessions rather than leaking hidden matches. Readable titles/cwd are length-bounded; `query` searches their title/cwd, not all transcript text. `offset`/`limit` paginate; concurrent changes can affect this simple list pagination.

### read

- `view:context` (default): Pi's current-leaf, compaction/context-edit-aware session projection. Original raw source entries are not returned alongside edited context.
- `view:raw`: complete persisted entry tree, including other branches. `since` is a raw entry ID, not a message count.
- `view:summary`: existing current-branch compaction/branch summaries only. No extra model call.
- Optional `entry_id`, `leaf_id` and `query` narrow a read. An unknown leaf is rejected rather than silently falling back.
- Returns `leaf_id`, revision and opaque `next_cursor`. Continue with identical session/view/filter arguments. Changes invalidate the cursor with `STALE_CURSOR`; re-read the projection after a context/branch change.
- Default 20 records / 12,000 serialized-content characters. Maximum 50 records / 32,768 serialized-content characters per call. Metadata and JSON framing add bounded overhead. One large record returns `json_fragment`, `char_offset`, `total_chars`; concatenate successive fragments before JSON parsing.

Reads use strict in-memory JSONL parsing plus Pi's pure projection helper. They never call `SessionManager.open` or migrate files on disk. Only valid version-3 files up to 32 MiB with noncyclic, unique entry IDs and existing project cwd are discovered. Invalid/in-progress/older files are omitted. Active bridge-owned processes supply current entries/leaf over RPC; saved sessions use the final persisted entry as leaf. This is **Pi session context, not the final provider request payload**; extension transformations and provider serialization are not reproduced.

### send

Caller supplies a stable `request_id`, `session_id`, `text` and optional mode:

- `native`: plain Pi prompt, no bridge queue policy; busy prompts receive Pi rejection.
- `idle_only`: resolve or resume first, then skip if streaming/compacting. Being saved is not busy.
- `steer`: Pi prompt with `streamingBehavior:steer`; starts when idle, steers when busy.
- `queue`: Pi prompt with `streamingBehavior:followUp`; starts when idle, follows up when busy.

Instance pool reuses owned live processes and automatically resumes saved files via official `pi --mode rpc --session <file>`. Returns Pi's preflight `started|queued|handled` disposition, not a promise of completed output. Receipts contain no target transcript content, so send-only access works independently of read. `agent_settled` is not attributed as the exclusive answer to a particular concurrent send; completion tracking is intentionally omitted.

Repeat the original request ID and identical arguments to replay its receipt. Repeat `send` with the same `session_id`/`request_id` and **omit text** to query it. Reusing an ID with different text/mode/operation/target returns `REQUEST_ID_CONFLICT`. Identical text with different IDs is a new input, not content deduplication.

A durable receipt is written before dispatch. Process crashes, transport failure or an ambiguous ACK window return/preserve `unknown`. A later authoritative ACK updates the original receipt. **Never change IDs and blindly resend after unknown.** This is not distributed exactly-once delivery. Receipts survive restart; their hashes contain no prompt text, but protect the local state directory because hashes are not an encryption scheme.

### create

Requires `folder_id`/`request_id` and owner `new_session`. Durably writes a valid version-3 header (file and directory fsync), making an empty session discoverable before any user/assistant message. No placeholder prompt, model call or implicit send. Send an initial prompt separately if permitted.

### delete

Requires `session_id`/`request_id` and independent delete permission. Stops its owned instance and confirms exit, then moves only the session JSONL into state-directory trash. Returns a restore token. Project files remain unchanged. Restore is an owner action: with the bridge stopped, move the corresponding trash JSONL back into configured storage; no permanent-delete tool exists. Same request ID replays the result.

## Verified

Run `npm test` for unit and real-process integration coverage:

- Permission inheritance, latest field/unset semantics, default deny and symlink handling
- No-read metadata/search suppression; send-only receipts
- Empty persistence, create-without-send, request-ID replay across restart
- Same-ID concurrent sends, distinct-ID repeated text, unknown timeout and late ACK repair
- Current branch, compaction checkpoint, context edits, raw incremental reads, existing summaries, bounded fragments and stale cursors
- Recoverable deletion and project-file preservation; draining shutdown, disconnected-process termination, oversized-ID and storage-overlap guards
- Official Pi RPC startup/resume with an isolated empty home
- Real Pi SDK with its faux provider, transcript persistence and automatic resume
- Standard MCP handshake and all five tools
- End-to-end MCP -> official Pi RPC -> faux provider with actual busy `native`, `idle_only`, `steer`, `queue`, context read and delete

Source research is pinned to `earendil-works/pi` commit `c5f5b3282d5e4203c085e59837ba17aeaf2829b5`. Runtime is the official published `@earendil-works/pi-coding-agent@1.1.0`, with exact direct dependency versions and lockfile. The upstream source checkout is kept separate and unmodified.

## Unfinished / limits

- No existing-TUI extension registration/IPC adapter yet. Pi's extension `sendUserMessage` returns void, so a thin adapter also needs honest acceptance/unknown handling; it cannot invent RPC preflight ACKs.
- No real provider credential, real model response or dot connector install was tested. All successful model responses are synthetic.
- No network hosting, multi-principal authentication, background discovery watcher, persistent snapshots, UI permission editor or completion attribution.
- Simple discovery reparses configured files and cursor continuation recomputes projections. This favors correctness and small scope over large-scale performance.
- Exposed storage must be exclusive. A second bridge with a different state directory or an independent writer is outside this prototype's locking scope.
- If a process crashes, the owner must confirm no old process is still using the state directory before removing a stale `bridge.lock`. It is never stolen automatically.
- Provider auth setup and enabling real coding tools are separate owner decisions. Do not copy credentials into chat or use a different account's browser/session.
