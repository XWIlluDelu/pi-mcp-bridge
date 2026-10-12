# Pi MCP Bridge

A local, vendor-independent MCP server for saved Pi sessions and Bridge-owned
RPC workers. It exposes `list`, `read`, `send`, `create`, `delete` and ordered `batch` over stdio and authenticated loopback Streamable HTTP.

Cooperating Pi TUI/RPC processes share their existing runtime through a private
Unix socket. Cooperative process identity and attachment require Linux.

## Install and try

Requires Node >=22.19.0 and the pinned dependencies in `package-lock.json`.

```sh
npm ci --ignore-scripts
npm test
node research/init-demo.mjs
node research/demo-client.mjs
node src/server.mjs "$PWD/demo/owner-config.json"
```

The demo uses synthetic sessions and an offline provider. Initialization preserves
existing demo configuration. The final command speaks MCP on stdin/stdout:

```json
{
  "command":"node",
  "args":["/absolute/path/pi-mcp-bridge/src/server.mjs",
          "/absolute/path/pi-mcp-bridge/demo/owner-config.json"]
}
```

For independent background access, see [loopback HTTP](deploy/HTTP.md). The
[stdio service kit](deploy/README.md) requires a client that owns the protocol
pipe and waits for Bridge shutdown.

## Owner configuration

`sessionRoots` contain private native JSONL files; `folders` are separately
configured project working directories. The owner file supplies the fixed caller
principal, runtime settings and independent `read`, `send`, `delete` and
folder-only `new_session` grants.

```json
[
  {"folder":"/projects/demo","read":true,"send":true,"new_session":true},
  {"folder":"/projects/demo/child","read":false},
  {"session_id":"ps_returned_opaque_id","send":false},
  {"session_id":"ps_returned_opaque_id","send":null}
]
```

Each permission defaults to deny. An explicit session rule wins, then the nearest
project rule. Later entries replace the same permission at the same scope; `null`
inherits. Project paths are canonicalized. Creation does not imply send access.

Entrypoints reload grants before requests. Other configuration changes require
restart (`CONFIG_RESTART_REQUIRED`). An invalid config blocks new requests;
already dispatched work may finish.

This is API authorization, not an OS sandbox. Owner-enabled tools run with host
privileges. Protect the owner file, receipts and state from untrusted local code.
Callers cannot override identity, roots, grants or runtime settings through tool
arguments. One Bridge holds each state directory; overlapping configured storage
and state directories are rejected.

### Native runtime defaults

Cold resume inherits the service environment, Pi agent directory and native
settings, saved model/thinking selection, tools, resources and authentication.
The service environment may differ from the interactive shell.

```json
{"piRuntime":{"tools":["read","bash"]},"piArgs":["--thinking","high"]}
```

Omitted/null `tools` and `inheritEnv` retain native defaults. `tools:[]` disables
tools; an explicit environment list filters inheritance while retaining PATH.
`agentDir` selects another profile. Environment filtering does not isolate
file-based credentials. Tests and the demo select isolation explicitly.

### Local controls and shared sessions

Launch ordinary Pi with the companion and permission menu, using the same private
IPC directory and owner configuration as Bridge:

```sh
cd /absolute/path/to/authorized-project
PI_MCP_OWNER_CONFIG=/absolute/path/to/owner.json \
PI_MCP_ATTACH_DIR=/absolute/path/to/private-ipc \
  pi --session /absolute/path/to/session.jsonl \
  -e /absolute/path/pi-mcp-bridge/src/attach-extension.mjs \
  -e /absolute/path/pi-mcp-bridge/src/owner-permissions-extension.mjs
```

Use a canonical private IPC directory owned by the same Unix user; new
directories are created with mode 0700.
Socket paths must fit within 100 bytes. Close the prior writer before opening
its file; registration coordinates participating writers, not arbitrary processes.
The TUI retains its native profile and credentials.

**Ctrl+Alt+P** edits existing project/session permissions using Allow, Block and
Inherit. It does not add roots, folders or callers. Edits preserve unrelated
configuration and reject detected concurrent changes.

Claims bind file, native ID, process identity and generation. A live unreachable
or transitioning owner blocks fallback. Bridge shutdown disconnects external
owners without terminating them. Delete requires confirmed writer exit, not just
socket closure. Registry/editor locks left by a crash require owner-confirmed
recovery after the relevant processes stop.

Session files must be canonical regular files with one hard link. Public IDs
bind canonical path and native header ID, not inode. Fresh native sessions may
reserve an uncreated path; once persisted, every attachment validates its storage.

Add `--mode rpc` for ordinary RPC; its caller retains stdin/stdout. The companion
uses a separate socket. RPC release/delete is unsupported because extension
shutdown does not confirm process exit. See [startup integration](docs/startup-integration.md).

Existing SDK/RPC hosts can [reserve and publish public bindings](docs/host-adapter.md)
before opening a session. Every host input and replacement path must participate
in its admission and release coordination.

Use [owner-local release/reset](docs/runtime-handoff.md) for Bridge-owned writers.
Release persists a no-cold-reacquire restriction until explicit reset; valid
attachments and saved reads remain usable. Its observed-idle checks and timed
teardown are not a graceful quiescence barrier.

## Tools

### list

Returns discoverable opaque session IDs and creation-capable folders. Readable
rows include bounded title/cwd, leaf and permissions; unreadable rows contain only
the ID. Query searches readable title/cwd. Offset/limit paginate rows.

Discovery reads native identity separately from transcript bodies and execution
cwd. Explicit session access can remain usable when its project directory is
unavailable; cold start/create require a usable canonical cwd.

### read

`session_id` is required. Views:

| View | Content |
| --- | --- |
| `context` (default) | Effective native projection with compaction and context edits |
| `raw` | Stored entries, including hidden originals and other branches |
| `summary` | Compaction/branch-summary records in the selected projection |
| `overview` | Extractive source locators, excerpts and tool observations |
| `status` | Current runtime state and settlement observation without transcript retrieval |

Live reads use the owner's entries/leaf; saved reads use the persisted resume
leaf. `leaf_id` selects ancestry, `entry_id` selects a source and `query` filters
serialized selected records. `since` selects entries after a raw entry ID and is
raw-only. Reads project native data without opening/migrating the session or
replaying context hooks. Saved Context differs from the final provider payload.

Default pages contain up to 20 records / 12,000 serialized-content UTF-16 units;
maximums are 50 / 32,768. Oversized records return `json_fragment`, `char_offset`
and `total_chars`; concatenate fragments before JSON decoding. Continue
`next_cursor` with the same selection; page budgets may change. Changed history
or selection yields `STALE_CURSOR`. Response metadata adds overhead.

Overview selects up to 19 records within 10,000 serialized units plus a manifest.
Its excerpts sample text blocks, pair tools by native call ID, and expose source
locators and omitted ranges. A missing tool result means unobserved, not running.
`entry_id`/`query` filter this selection, not the whole history. Excerpt offsets
address serialized JSON. Use source-linked context/raw reads for complete content.

`activity` describes the current runtime separately from the content snapshot,
including on historical reads. Unknown values remain unknown; saved-history reads
do not start a runtime.

`overview_scope` reports pre-filter coverage on every page, including when
filters exclude the manifest record.

#### Precise projected text

```json
{"session_id":"ps_...","view":"context","entry_id":"native-entry-id",
 "message_index":0,"block_index":1,"text_offset":0,"max_chars":512}
```

String content needs no block index; array content requires an exact text block.
For a system section, replace `block_index` with
`"field":"sections","section":"project_context"`. Only an own string-valued
section is readable. Native hidden/replacement semantics and empty text are preserved.

The response uses `format:"projected_text"` and `offset_unit:"utf16_code_units"`.
Offsets address decoded text; pages do not split surrogate pairs. Continue with
identical selectors, including the initial offset. Selection is context-only and
excludes `query`/`since`. Invalid or nontext selections return errors.
`OWNER_READ_REFRESH_REQUIRED` identifies an owner whose loaded reader cannot honor
the selector; update that owner, not just Bridge. Ordinary JSON cursors are separate.

#### Status and wait

Capture `activity.settlement` before sending, then wait for a later session event:

```json
{"session_id":"ps_...","view":"status",
 "after_settlement":{"generation":"observed-generation","sequence":0},
 "wait_ms":10000}
```

Wait is 0–10000 ms; nonzero wait requires a baseline. Outcomes distinguish
`settled`, `timeout`, `generation_changed`, `unavailable` and `not_requested`.
Generation replacement resets sequence. Settlement is session-wide, not exclusive
send completion or proof of current idle. It cannot clear an uncertain ACK.
An initial observation always runs; the deadline bounds polling while in-flight
state/ownership I/O retains its own timeout. Permissions are rechecked on return.
Stdio cancellation stops the wait; stateless HTTP requires disconnecting the
original request rather than a separate cancellation notification.

### send

Use a stable `request_id`, `session_id`, `text` and optional mode:

- `native`: ordinary Pi prompt; busy input may be rejected.
- `idle_only`: resolve/resume, then skip if streaming/compacting.
- `steer`: start idle, steer busy.
- `queue`: start idle, follow up busy.

Owned RPC reports `started|queued|handled` admission, not completed model output.
`timeout_ms` bounds admission ACK wait, not execution. Reuse the ID and identical
arguments to replay, or omit text to retrieve the receipt. Different text, mode,
operation or target conflicts. Same text with a new ID is a new input.

Receipts persist before dispatch and survive restart. A lost ACK remains `unknown`;
a verified late ACK can update it. Reusing the ID recovers the outcome without
redispatch; a fresh ID risks duplicate work. Keep receipt storage private.

Companion sends return `unknown/PI_ACCEPTANCE_UNOBSERVABLE`: the public send API
returns void. Its idle check is observational, not atomic against other inputs.

An unresolved owned prompt ACK blocks another prompt with
`PROMPT_ADMISSION_PENDING` until that ACK or exact child exit. Idle/settlement
observations do not clear this fence.

### create and delete

Create requires `folder_id`, `request_id` and `new_session`. It durably writes an
empty v3 session without a model call. Send an initial prompt separately if allowed.

Delete requires its own permission and confirmed writer exit. It moves only the
JSONL, preserving project files, and returns a replayable restore token.

Deleted files and restore metadata live in adjacent private `.pi-mcp-trash`,
with an index under the state directory. With Bridge stopped, inspect original
and trash paths, then restore to the recorded original path without overwriting
an existing file. Older trash can reside in the state directory.

Path/native identity determine public IDs and session grants. There is no
permanent-delete or remote restore tool.

### batch and receipts

Batch accepts 1–10 ordered `read|send|create|delete` items. Preflight checks shape
and request-ID conflicts; results preserve input order with per-item errors.

Read-before-delete is valid; delete-before-read and same-session send/delete
are contradictions. Reads are captured once and resized without rereading after
later mutations. Small reads release response capacity to larger reads.

Input is capped at 6,100,000 serialized characters. The whole structured result
is bounded to 32,768; `BATCH_RESULT_OMITTED` directs a separate read or same-ID
mutation replay. This is not a transaction: replay repeats reads and recovers
mutation receipts.

Once admitted, later mutations continue after HTTP disconnect. A cancelled
status wait may produce an item error without stopping the batch.

## Verification and recovery

`npm test` covers permissions, native projection, bounded reads, durable receipts,
MCP transport and actual Pi RPC/SDK behavior with disposable offline fixtures.
The runtime dependency is Pi 1.1.0. Real-provider checks are separate and require
explicit destination authorization:

```sh
PI_REAL_TEST=1 \
PI_REAL_BASE_URL=https://example.invalid/v1 \
PI_REAL_ACK_DESTINATION=https://example.invalid/v1 \
OPENAI_BASE_URL=https://example.invalid/v1 \
PI_REAL_MODEL=your-model \
node research/real-client.mjs
```

Supply the matching credential through protected environment. Destination and
acknowledgement must match; the harness uses an isolated, tool-disabled profile.

`PI_REAL_REVIEW=1` reviews public HEAD source; `PI_REAL_REVIEW_ONLY=1` skips
lifecycle prompts. Feedback is untrusted and output stays local. Reusable
long-session measurements are described in [research notes](research/long-session-reading.md).

For compatible provider endpoints, `PI_REAL_THINKING_FORMAT=deepseek` requests
native thinking-disable serialization; `reasoning:false` alone does not disable
provider-side thinking.

Preserve native session identity and mutation request IDs during recovery.

Before removing a stale Bridge, registry or permission-editor lock, confirm the
relevant processes have stopped. Unregistered writers remain outside cooperative
coordination.

Optional content-free `PI_MCP_LOG=1` diagnostics write to stderr; see
[measurement boundaries](deploy/diagnostics.md).
