# Direct native Pi command

`bash` is a separate remote entry point for native terminal `!command`,
not a prompt sent to a model. `send` retains normal prompt semantics.
Execution uses Pi's existing environment, cwd and shell configuration.

## Independent owner switch

Direct bash is opt-in/default-denied. Add an explicit `bash:true` project/session grant
only when desired. `bash:false` blocks it, `null` inherits, and an absent grant
denies by the existing permission resolver. The human permission menu labels it
**Direct bash**.

`send`, stop's `command`, and `bash` are independent. Enabling prompt or
stop access never implicitly enables direct shell. Owners can have prompt-only,
direct-command-only, or both. Stop still requires `command` and `read` to
return other queued text; direct bash authorizes the caller's **own command
result**, without opening transcript read. Output replay rechecks current
`bash` authorization.

This switch gates this API at the backend, not merely tool visibility. It is not
an OS sandbox: an allowed shell command has Pi's normal host privileges, and
blocking this tool does not remove model tools or local/native shell access.

## Call and native behavior

```json
{"session_id":"ps_...","request_id":"command-1","command":"pwd","max_chars":12000}
```

Use the raw command string, without an extra leading `!`. The tool is not a
batch item. An inactive authorized session can cold-resume through the normal
Pi startup path; existing attached owners are reused without a fallback writer.
Explicit release restrictions still block cold reacquisition.

Owned Pi and RPC bindings invoke native `bash`, including `user_bash`
extensions and native `bashExecution` recording. SDK bindings use public
`extensionRunner.emitUserBash`, `executeBash`, and `recordBashResult` with
the same hook/result/operations handling. Pi handles cwd, shell path, command
prefix, environment, native cancellation and output sanitization. Commands record
as `!`; `!!` exclusion is outside this API. Extensions must coordinate cancellation
of their own asynchronous preflight and background work.

Exit code 7 is a completed native result, not transport rejection.
`cancelled:true` reports native cancellation; the process and session survive.
`accepted/completion:native_bash_result` confirms Pi returned a native result.
Use its exit code and cancellation fields to interpret execution; already
executed effects remain.

Use a stable request ID. Repeat it without `command` to recover its private
receipt/output. Cursor requests only look up an existing receipt, even if
`command` is repeated; a missing receipt returns `RECEIPT_NOT_FOUND` without
execution. A different command under that ID conflicts. ACK uncertainty
never reruns a command; an owned RPC late ACK can persist the eventual result.
The generic host stores results before flushing its IPC ACK, making captured
output recoverable even if the socket disappears.

`timeout_ms` (50–30,000, default 5,000) is an ACK wait budget, not an execution
timeout or SIGKILL. The command may continue after `unknown`; use the existing
stop control when authorized. Simultaneous Bridge bash admissions are rejected
while a request is awaiting its result, not placed into a hidden command queue.
A stop also invalidates commands still awaiting native dispatch, even if the
stop completes before their state/preparation checks return.

## Output budgets

`output` contains Pi's sanitized combined stdout/stderr. Pi can truncate the
inline result; `truncated` and any `fullOutputPath` are preserved. Bridge pages
that returned result without opening spill files.

Bridge pagination never silently truncates the **returned native result**.
Default/maximum `max_chars` is 12,000/32,768 serialized UTF-16 units in
`{"output":"..."}`, excluding receipt metadata.
Follow `next_cursor` with the same session/request ID until
`output_complete:true`, concatenating `output`. Offsets count decoded UTF-16
code units without splitting surrogate pairs. Cursor binding includes the
native result/identity/generation; permission is rechecked on every page.
Private results use existing Journal storage under `attachmentDir/bash/receipts/`.

## Generic host and companion

Optional callback:
`bash({command,sessionFile,sessionId,beforeDispatch,onResult})`.
Use the host's public native execution/hook/recording methods, call
`beforeDispatch()` immediately before native execution after asynchronous
preparation, then await `onResult(nativeBashResult)` and return
`{completed:true}`. Hosts exposing bash must also provide the native stop
callback, keeping direct commands cancellable. SDK/RPC bindings supply both.
As with other host callbacks, the owner coordinates its own additional queues
and preparation; this is not universal process arbitration.

The ordinary companion and hosts without this seam return
`BASH_UNSUPPORTED`, with no execution and no second writer. Public extension
`pi.exec` is not substituted: it is not the native session bash recording/
Escape cancellation path.

Offline test suites verify: native hooks and recording, independent grants and
backend denial, paged output and replay, nonzero exit codes, lost ACK recovery,
stop cancellation, and subsequent prompt continuation.
