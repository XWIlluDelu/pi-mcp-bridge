# Optional backend diagnostics

Set `PI_MCP_LOG=1` in the Bridge environment to write JSON lines to stderr; the
default is off. Stdout remains protocol-only. Change the environment through an
owner-managed restart, not a second Bridge against active storage. Keep logs
private and configure collection/rotation in the supervisor.

Records contain UTC `time`, `pid`, process `run_id`, request `trace_id` and
monotonic `duration_ms` where applicable.

| Events | Measured boundary |
| --- | --- |
| `http.received/closed` | Headers through local finish/close, including upload, auth and tool work; finish means Node wrote the response, not remote delivery. |
| `http.rejected` | Local HTTP rejection status, without headers/body. |
| `tool.start/end` | Validated tool execution before response delivery. Invalid protocol/schema requests may have only HTTP records. |
| `batch.item.start/end` | One batch operation and index. |
| `permission.reload.start/end`, `permission.check` | Grant reload including serialization wait, then Bridge allow/deny; list filtering stays within list duration. |
| `session.discover.start/end`, `read.source` | Discovery/loading and saved/RPC/attached source selection. |
| `rpc.command.start/end`, `attached.request.start/end` | Command/request round trip, error or timeout; identity checks are separate `get_state` calls. |
| `runtime.start.start/end`, `runtime.spawned/exited/reused` | Startup/readiness and child lifetime/reuse. |
| `runtime.attach.start/end`, `runtime.detached` | Attached generation connection/retirement. |
| `receipt.saved/replay`, `rpc.late_ack` | Durable receipt update/recovery; late callbacks keep their original trace. |
| `service.ready/stopping` | Backend lifecycle; restart changes `run_id`. |

`mcp_id_ref`, `mutation_ref` and `session_ref` are the first 24 hex characters of
SHA-256 over the JSON-encoded ID. They correlate across restarts but do not
anonymize guessable IDs. Reused JSON-RPC IDs still receive distinct trace IDs;
mutation `request_id` controls side-effect deduplication.

Metadata is allowlisted: no content, paths, arguments, headers, tokens, raw IDs,
error stacks/messages or Pi stderr. Unknown error codes become `OTHER_ERROR`.
Sink errors are suppressed and records drop if queued stderr exceeds ~64 KiB;
diagnostics provide operational tracing rather than a lossless audit log.
Synchronous stderr destinations can introduce latency, so keep logging and
collection settings consistent during performance measurements.

## Diagnose an operation

Group by run/trace. HTTP time contains tool time, which contains discovery,
permission and RPC work: **do not add nested durations**. Repeated `get_state`
commands check identity rather than repeating prompts. Inspect grant failures and
permission reload errors separately from transport errors.

After a lost response, query the same mutation ID without input. A new trace with
`receipt.replay` and the same mutation reference shows receipt recovery. HTTP close
does not cancel admitted work; late ACKs may update its receipt. A new generation
means a replaced runtime; a live unreachable owner still blocks fallback.

`accepted`/`started` describes admission. Companion `unknown/submitted` remains
uncertain acceptance. Observe content using a same-session read rather than treating
idle, ACK or HTTP finish as model-completion timestamps.

## Compare local and remote routes

Use an authorized synthetic fixture and fixed code/profile. Keep raw samples and
deployment details private.

1. Issue identical bounded `list`/`read` calls locally and remotely. Fix view, leaf,
   limits and budgets; record source kind, payload size, client and connection reuse.
2. Separate one cold request from repeated warm requests, alternating route order.
   Record monotonic client duration, IDs, result and backend trace; report samples
   and median/range. Include authentication/approval state. Matching by time alone
   is weaker than an explicit request correlation.
3. Compare client, HTTP and tool durations. Their differences include client
   scheduling, proxy/network, platform work and delivery; they do not isolate one
   layer. Stdio exposes only tool duration and needs separate client timing.
4. Measure prompt admission, first read observing output, polling interval and
   provider-reported duration separately. Exercise disconnect/recovery with the
   original mutation ID; do not sum overlapping intervals.
