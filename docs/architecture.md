# Architecture and verification

## Component versions

`package.json` defines the product version. The control envelope binds requests
and replies to the generation, canonical file and native session ID. Bridge puts
the target's advertised release in the existing wire `version` slot so running
owners recognize the request. Operations depend on the current envelope,
request and reply shapes, and the required owner capability. Live reads use
`READ_CONTRACT` and report `OWNER_READ_REFRESH_REQUIRED` when it differs.
The writer claim remains in force through interface mismatches. See
[AGENTS.md](../AGENTS.md) for the release and ownership rules.

## Request path

- `protocol.mjs` validates public tool arguments. Direct and proxied stdio
  share framing and reply cancellation in `protocol-stdio.mjs`. The HTTP
  service authenticates loopback requests. `batch.mjs` orders same-session
  operations and allocates a shared response budget.
- `bridge.mjs` applies the permission snapshot and coordinates reads, mutations
  and lifecycle fences. `permissions.mjs` resolves rights. `submissions.mjs`
  retains late admission receipts.
- `data.mjs` validates native storage and discovers recorded identities.
  `context-read.mjs` and `read-navigation.mjs` select and sanitize native
  content. `read-cache.mjs` retains frozen pages and references.
- `rpc.mjs` owns child lifecycle and ACK tracking. The native observer checks
  activity and seals idle shutdown. `attachments.mjs` manages writer claims;
  `companion.mjs` and `host-adapter.mjs` expose existing owners over private IPC.
- `create-session.mjs`, `trash.mjs` and `idle-handoff.mjs` handle session
  publication, recoverable deletion and transfer to a local writer. Optional
  Herdr placement uses the same Bridge-owned RPC path.
- [Integration modules](compatibility.md) provide input mappings, context
  readers and daemon environment filters. [Completion events](events.md)
  capture the native settlement boundary before asynchronous webhook delivery.

## Invariants

1. **One writer.** A live or uncertain owner blocks another writer. A claim ends
   after exact process exit, completed native replacement or confirmed
   session-local writer closure by its host.
2. **Request authorization.** One receive-time policy snapshot governs an
   operation, including batch items and fork checks. Identity, Stop and lifecycle
   fences remain live throughout execution.
3. **Native outcomes.** External dispatch evidence does not imply native admission.
   Missing ACKs leave outcomes unknown; bounded `submissions.mjs` receipts retain
   matching late ACKs without replay. Shutdown drains received ACK checks and captures.
4. **Ordered release.** Close admission, cancel when authorized and drain admitted
   work and captures. Non-interrupting owned RPC shutdown requires the child to
   synchronously check idle and seal new business work before EOF; exact exit
   precedes claim release. An unknown seal acknowledgement retains ownership and
   admission fences. See the [shutdown contract](runtime.md#shutdown-and-in-flight-acks).
5. **Native provenance.** Projection order determines prompt ownership and tool
   pairing. Fork uses raw native records rather than the public read projection.
6. **Frozen, bounded reads.** Cursors retain selected history and identity while
   each page rechecks authorization. Budgets include structured results and the
   duplicated wire envelope; batch never rereads after a later mutation.

## Verification

Run `npm test` and `npm run format:check`. Tests use temporary native stores,
isolated agent environments and synthetic providers without credentials or paid
endpoints. CI runs both commands on Node 22 and 26 for `main` pushes and pull
requests. Native subprocess/PTY checks require `script`; the service-unit check
requires `systemd-analyze`. The test environment must permit Unix sockets and
preserve the Linux file ownership needed by the storage-integrity checks.

Module tests live beside their implementations under `integrations/`.

Pi is an external test dependency. Tests use PATH or an explicit installation:

```sh
BRIDGE_TEST_PI_CLI=/absolute/path/to/pi npm test
```

The optional real Herdr check needs a working user-systemd bus:

```sh
BRIDGE_TEST_HERDR=/absolute/path/to/herdr node --test test/herdr-runtime.test.mjs
```

It creates and removes an isolated named daemon. Normal test runs skip this
opt-in check. `npm audit` checks dependency advisories separately.

## Operational boundaries

The cooperative registry requires one machine, a shared canonical IPC directory
and compatible Linux PID/network namespaces. Unregistered writers need host
coordination before reopening; see [runtime](runtime.md). The HTTP backend uses
an owner-local token, with public authentication supplied by a tunnel; see
[transports](transports.md).
