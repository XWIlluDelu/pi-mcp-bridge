# Cooperating Pi hosts

A host can share an existing SDK session or RPC child through private per-session
IPC. Ordinary Pi TUI uses the companion instead. Each route uses the owner's
configured attachment directory and grants.

## Reserve before opening

Reserve the canonical file and native ID before opening a writer. Existing
unregistered writers must drain and close through their host before reopening
with this integration. The host coordinates every input, switch and close path.

`reserveHostSession(...).ready(callbacks)` publishes:

- `state()`: native `sessionFile`, `sessionId` and observed activity.
- `snapshot()`: the same identity, native `entries` and `leafId`.
- `submit({text,mode})`: a bounded admission receipt.
- Optional `release()`: `{released:true}` only after all admissions have stopped,
  pending preparation/work has drained or been cancelled, and the writer has closed.

Host lifecycle sketch:

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

For RPC, start the host's child with `--no-session`, retain its request
routing, and obtain its PID/start/boot identity from the host process manager.
Reserve the target for that child before calling public `switchSession`.
Confirm the switch succeeded, then publish its binding. The binding neither
starts another child nor manages the existing child's stdin/stdout.

## Admission and activity

The SDK binding calls public `AgentSession.prompt`, whose promise follows
completion rather than admission. It tracks that promise and immediately returns
`unknown`, `dispatch:submitted`, `PI_ACCEPTANCE_UNOBSERVABLE`.

RPC `prompt` ACKs return Pi's `started|queued|handled` disposition. The public
client exposes rejection and transport failure as untyped errors, so thrown
submission errors remain `unknown`. Recover with the same request ID rather than
resending uncertain input. Neither route attributes later output exclusively to
one send.

`native` retains normal Pi prompt behavior; `steer` and `queue` choose native
streaming delivery. `idle_only` checks observed idle/streaming/compaction state;
other host surfaces can change that state before admission.

## Release and replacement

Without a release callback, reads and sends remain available but host-assisted
deletion is disabled. Release must cover all host queues and asynchronous input
preparation; `abort()` and `dispose()` alone do not establish that drainage.
Bindings also wait for their own tracked submission promises.

`controller.close()` retires the endpoint while a live writer's claim continues
to block competitors. Use explicit release before switching or reopening the
registered target. Successful release stops that endpoint while the shared host
can remain alive. A failed release leaves admission closed and the claim blocking.

Deletion releases the exact generation, then reserves a deletion claim before
moving the file. Another owner winning that interval leaves the file in place.
A surviving RPC child retains its own process identity even if its controller dies.

## Executable examples

```sh
node --test test/host-integration.test.mjs
```

The fixtures include complete imports, temporary sessions and an offline provider.
They exercise public `createAgentSession`, `SessionManager.open`, `RpcClient`,
independent SDK sessions and drainage of an asynchronous input hook before release.
Integration targets Pi 1.1.0 public SDK/RPC APIs; Pi Durable has a different storage
lifecycle and is not wired through these bindings.
