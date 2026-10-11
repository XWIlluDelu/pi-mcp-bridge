# Pi MCP Bridge

A local, vendor-independent MCP server for saved Pi sessions and Bridge-owned
RPC workers. It exposes `list`, `read`, `send`, `create` and `delete` over stdio.

Use exclusively owned session storage. Existing TUI attachment is not implemented;
an independent writer does not participate in Bridge locking.

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

Configuration is loaded at startup; restart Bridge after changing it.

This is API authorization, not an OS sandbox. Owner-enabled tools run with host
privileges. Protect the owner file, receipts and state from untrusted local code.
Callers cannot override identity, roots, grants or runtime settings through tool
arguments. One Bridge holds each state directory; overlapping configured storage
and state directories are rejected.

### Runtime profile

Cold resume defaults to an isolated agent directory, no inherited provider
credentials and no tools. Explicit owner options select another profile:

```json
{
  "piRuntime": {
    "agentDir":"/absolute/path/to/pi-agent",
    "inheritEnv":["OPENAI_API_KEY","HTTPS_PROXY"],
    "tools":["read","write","edit"]
  },
  "piArgs":["--provider","approved-provider","--model","approved-model"]
}
```

Pi resolves its models and authentication. Use environment interpolation in Pi
configuration rather than copying credentials into Bridge configuration.

HOME remains isolated even with a profile. Automatic extensions, skills, themes
and prompt templates are disabled; explicit CLI options can load selected resources.

## Tools

### list

Returns discoverable opaque session IDs and creation-capable folders. Readable
rows include bounded title/cwd, leaf and permissions; unreadable rows contain only
the ID. Query searches readable title/cwd. Offset/limit paginate rows.

Discovery parses configured native v3 histories, requires an existing project
cwd, and omits invalid/in-progress files and files over 32 MiB.

### read

`session_id` is required. Views:

| View | Content |
| --- | --- |
| `context` (default) | Effective native projection with compaction and context edits |
| `raw` | Stored entries, including hidden originals and other branches |
| `summary` | Compaction/branch-summary records in the selected projection |

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

### create and delete

Create requires `folder_id`, `request_id` and `new_session`. It durably writes an
empty v3 session without a model call. Send an initial prompt separately if allowed.

Delete requires its own permission and confirmed writer exit. It moves only the
JSONL, preserving project files, and returns a replayable restore token.

Trash and private `<restore_token>.restore.json` metadata live under the state
directory. With Bridge stopped, restore to the recorded `original_path` without
overwriting an existing file; older trash may lack metadata.

Path/native identity determine public IDs and session grants. There is no
permanent-delete or remote restore tool.

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

The optional `PI_REAL_REVIEW=1` source-review path requires the Git revision
configured in `research/real-client.mjs` to be available locally.
`PI_REAL_REVIEW_ONLY=1` skips lifecycle prompts. Review output is untrusted.

For compatible provider endpoints, `PI_REAL_THINKING_FORMAT=deepseek` requests
native thinking-disable serialization; `reasoning:false` alone does not disable
provider-side thinking.

Preserve native session identity and mutation request IDs during recovery.

Before removing a stale Bridge state lock, confirm its old process has stopped.
A separate writer or Bridge with another state directory is outside this lock.
