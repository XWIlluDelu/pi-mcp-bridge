# Cooperating Pi hosts

A host can share its existing SDK sessions or RPC children through private
per-session IPC. It integrates reservation and callbacks into every open, input,
switch and close path. Existing unregistered writers must first drain and close
through their host, then reopen under this contract.

Ordinary Pi TUI/RPC uses the companion instead. If the companion finds its same
process/file/native ID already registered by a host or Bridge RPC controller,
it leaves that claim and lifecycle with the controller.

`src/host-adapter.mjs` exports `reserveHostSession`. Its callbacks are small:

- `state()` returns `sessionFile`, `sessionId` and observed activity fields.
- `snapshot()` returns the same identity plus native `entries` and `leafId`.
- `submit({text, mode, beforeDispatch})` returns a bounded admission receipt.
  After any asynchronous preparation, call `beforeDispatch()` immediately before
  entering Pi. The shared bindings do so; a stop invalidates pending input even
  after cancellation completes, and a closing controller rejects new dispatch.
- Optional `release()` confirms `{released:true}` only after the host has
  drained all work for this session and closed its writer.

`src/host-bindings.mjs` supplies `createSdkHostBinding(session, options)` and
`createRpcHostBinding(client, options)`. Options are the host's
`release` callback and an optional `onError` observer. The host retains native
instance creation, file opening and RPC stdout routing.

## Reserve before opening a writer

Resolve the saved target's canonical file and native ID with Bridge's identity
reader. Reserve it in the shared attachment directory before opening it in the
SDK or switching an RPC child to it. Use the actual writer's process identity.
These are trusted owner callbacks; Bridge still checks ordinary grants.

For an SDK session, reserve with the current host process identity, then create
the session with public Pi SDK APIs and the target's `SessionManager`. Publish
only when it is bound to that identity. This is an integration sketch: the
host supplies its SDK configuration and full admission/drain implementation;
`hostDrainAndCloseSession` is not a Pi API:

```js
const controller = await reserveHostSession({ attachmentDir, session: target });
// The host now opens target.file through its normal Pi SDK creation path.
const { session } = await createAgentSession({
  ...hostSdkOptions,
  sessionManager: SessionManager.open(target.file),
});
const binding = createSdkHostBinding(session, {
  release: async () => {
    // Host-specific: stop all session admission, abort/drain work from every
    // surface, and close/dispose this session's writer before confirming.
    await hostDrainAndCloseSession(session);
    return { released: true };
  },
});
await controller.ready(binding);
```

For executable examples against the pinned Pi 1.1.0 dependency, run:

```sh
node --test test/host-integration.test.mjs
```

The [integration tests](../test/host-integration.test.mjs) provide complete
imports, saved-session setup and an offline provider. Examples cover RPC,
two independent SDK sessions and a host gate that drains asynchronous input
preparation before release. Hosts with additional input surfaces need that gate;
`abort()` and `dispose()` alone do not drain all preparation.

For RPC, the host starts its child with `--no-session` and owns its ordinary
request demultiplexer. Obtain that child's exact process identity from the
host's own process manager; reserve the saved target with that owner. Only
then call the existing client's public `switchSession(target.file)`. Check
that switching was not cancelled and publish the RPC binding. The host owns startup and switching; the binding reuses its existing client.

The host must coordinate every surface that can switch, replace, close or
submit work to its sessions. State identity checks can detect observed changes;
they cannot make unrelated host mutations atomic. An already-open unregistered
writer cannot be retroactively made safe by claiming its file after opening.

## Admission is distinct from completion

The SDK binding dispatches through public `AgentSession.prompt`. This promise
tracks completion rather than admission, so the binding immediately reports
`status: unknown`, `dispatch: submitted`, and `reason: PI_ACCEPTANCE_UNOBSERVABLE`.
Use `send` with the same request ID to recover its receipt, and session reads to
observe progress separately. A later rejection can still follow side effects.
The binding uses public APIs rather than the internal `preflightResult` hook.

The RPC binding calls the existing client's public `prompt` method. Its
successful ACK returns `accepted` with Pi's actual `started`, `queued` or
`handled` disposition. The public client exposes negative ACKs and transport
failures as plain errors without a safe typed distinction, so thrown submission
errors conservatively return `unknown`; raw messages are not parsed or exposed.
Observe completion separately and recover uncertain results with the same ID.

`native` uses Pi's normal prompt behavior. `steer` and `queue` select
`streamingBehavior: steer` and `streamingBehavior: followUp`. `idle_only` checks
observed native idleness (SDK) or observed streaming/compacting state (RPC)
before dispatch. It retains the bridge's observed-idle semantics: this check
does not provide atomic admission against another host surface.

## Remote stop

An optional generic `stop({sessionFile,sessionId,onWithdraw})` callback supports
native cancellation plus recoverable queue withdrawal, distinct from `release`.
Public SDK/RPC bindings provide it when their runtime exposes `clearQueue`,
`abort` and `abortBash`. The callback must capture full text, handle any additional
host queues, and never close the writer. Stop uses independent `command` plus
`read` grants; missing capability returns `STOP_UNSUPPORTED`. See the
[stop contract](stop.md) for acknowledgement, pagination and companion limits.

## Direct native commands

Optional `bash({command,sessionFile,sessionId,beforeDispatch,onResult})` reuses
public native execution/hooks/recording. Call the admission check immediately
before execution, capture the full native result before returning `{completed:true}`,
and provide the existing stop callback. SDK/RPC bindings include both; ordinary
companion/old owners return `BASH_UNSUPPORTED`. Independent opt-in `bash` grants
are not derived from prompt or stop grants. See [native command contract](bash.md).

## Release and failure

Omitting the release callback disables host-assisted deletion while keeping reads
and submissions available. A valid release must halt new admissions, drain or cancel
active work across all surfaces, and close the per-session writer before confirming
`{released: true}`; closing a socket or observing transient idle without closing the
writer is insufficient. Bindings additionally wait for their own tracked submission promises.

`controller.close()` drains admitted operations and closes the endpoint, retaining
any live writer's claim. If the registry update fails, cleanup still runs and the
original error is returned; the claim continues to block a competing writer.
Use explicit release before switching or reopening the registered target.
Successful release stops that endpoint while the shared host can remain alive.
A failed release leaves the claim blocking and admission closed.

Deletion releases the exact host generation, then reserves a deletion claim before
moving the file. If another owner wins that interval, deletion leaves the file in
place. A surviving RPC child is identified by its own PID/start/boot identity even
when its controller dies.

Bindings target Pi 1.1.0 public SDK/RPC APIs. Pi Durable uses a different storage
lifecycle and needs its own integration.
