# Direct native Pi command

`bash` is a separate remote entry point for native terminal `!command`,
not a prompt sent to a model. `send` retains normal prompt semantics.
There is no second executor, environment profile, cwd override or shell configuration.

## Independent owner switch

Direct bash is opt-in and defaults to deny. Add an explicit `bash:true` grant
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
the same hook/result/operations handling. Native cwd, shell path, command prefix,
environment, cancellation and output sanitization remain Pi's responsibility.
Arbitrary asynchronous extension preflight/hooks have no universal native
cancellation barrier; this tool does not add one. The recorded command/result
enters native history/context exactly as `!`;
this tool does not add `!!` exclusion behavior or fabricate a prompt.

Exit code 7 is a completed native result, not transport rejection.
`cancelled:true` reports native cancellation; the process and session survive.
`accepted/completion:native_bash_result` means the native result was obtained,
not that the command's side effects succeeded or were rolled back.

Use a stable request ID. Repeat it without `command` to recover its private
receipt/output. A different command under that ID conflicts. ACK uncertainty
never reruns a command; an owned RPC late ACK can persist the eventual result.
The generic host stores results before flushing its IPC ACK, making captured
output recoverable even if the socket disappears.

`timeout_ms` (50–30,000, default 5,000) is an ACK wait budget, not an execution
timeout or SIGKILL. The command may continue after `unknown`; use the existing
stop control when authorized. Simultaneous Bridge bash admissions are rejected
while a request is awaiting its result, not placed into a hidden command queue.

## Output budgets

`output` is Pi's returned sanitized combined stdout/stderr. Pi may itself
truncate it: `truncated:true` and `fullOutputPath` preserve that native fact;
Bridge does not auto-read the spill file or promise unlimited shell output.

Bridge pagination never silently truncates the **returned native result**.
Default/maximum `max_chars` is 12,000/32,768 serialized
`{"output":"..."}` characters, excluding receipt metadata.
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

The ordinary companion and old hosts without this seam return
`BASH_UNSUPPORTED`, with no execution and no second writer. Public extension
`pi.exec` is not substituted: it is not the native session bash recording/
Escape cancellation path.

Tests use only disposable offline RPC/SDK sessions and synthetic owner IPC:
native hooks/recording, no model prompt, separate grants, backend deny,
paged/replayed output, nonzero exits, lost ACK recovery, direct-command stop
and subsequent prompt continuation.
