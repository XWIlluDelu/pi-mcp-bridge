# Architecture and verification

## Component versions

`package.json` defines the Bridge version reported by MCP and used for owner read
compatibility. Bridge and companion/host components must match. A different or
missing owner read version returns refresh guidance without taking over its
writer; update running components at a safe native lifecycle boundary.

Native history projection and raw fork snapshots remain supported independently
of the Bridge control version. [AGENTS.md](../AGENTS.md) defines release,
development and production-operation rules.

## Components

| Area                           | Modules and responsibility                                                                                                                                                                                                                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol                       | `protocol.mjs` and `tool-schemas.mjs` define tools and dispatch. `server.mjs`, `protocol-stdio.mjs` and `http-server.mjs` provide MCP transports; `stdio-proxy.mjs` forwards to one service.                                                                                                                   |
| Authorization and admission    | `bridge.mjs` composes request snapshots, permissions, session lanes and lifecycle fences. `permissions.mjs` resolves rights; `owner-config.mjs` validates and edits policy. `submissions.mjs` retains admission receipts.                                                                                      |
| Native data and reading        | `data.mjs` validates session identity and storage. `context-read.mjs` projects, selects and sanitizes; `read-navigation.mjs` builds previews and search; `read-cache.mjs` manages frozen pages and references. `session-metadata.mjs` caches bounded titles.                                                   |
| Plugin integration             | `compatibility.mjs` owns module lifecycle. `compatibility-services.mjs` exposes independent input-mapping, session-reader and daemon-environment capabilities; `session-readers.mjs` routes session-local context.                                                                                             |
| Runtime ownership              | `rpc.mjs` owns child lifecycle and ACK tracking. `attachments.mjs` coordinates claims and IPC; `attach-extension.mjs` and `host-adapter.mjs` connect cooperating owners. `herdr-rpc-transport.mjs` supplies optional process placement.                                                                        |
| Native controls                | `pi-installation.mjs` selects one external CLI/SDK installation. `model-catalog.mjs`, `set-model.mjs`, `compact.mjs` and `stop-execution.mjs` implement native controls.                                                                                                                                       |
| Creation, deletion and handoff | `create-session.mjs` publishes native sessions; `trash.mjs` performs recoverable moves. `owner-runtime.mjs`, `idle-handoff.mjs`, `join-extension.mjs` and `open.mjs` coordinate local entry and release.                                                                                                       |
| Observation and events         | `context-observation.mjs` retains request-stage context; `live-message.mjs` and `runtime-events.mjs` bound transient observations. `settled-result.mjs` captures completion excerpts; `events.mjs` and `event-webhook.mjs` deliver notifications. `diagnostics.mjs` emits privacy-filtered operational events. |

## API distinctions

[API](api.md) defines operations, [configuration](configuration.md) defines
permission snapshots, [runtime](runtime.md) defines ownership and host contracts,
and [reading](reading.md) defines projection and pagination. Optional integration
APIs are in [module management](compatibility.md).

## Invariants

1. **One writer.** A live or uncertain owner blocks another writer. Only exact
   process exit or completed native replacement ends its ephemeral claim.
2. **Request authorization.** One receive-time policy snapshot governs an
   operation, including batch items and fork checks. Identity, Stop and lifecycle
   fences remain live throughout execution.
3. **Native outcomes.** External dispatch evidence does not imply native admission.
   Missing ACKs leave outcomes unknown; bounded `submissions.mjs` receipts retain
   matching late ACKs without replay. Shutdown drains received ACK checks and captures.
4. **Ordered release.** Close admission, cancel when authorized, drain admitted
   work and captures, then close the writer and release its claim.
5. **Native provenance.** Projection order determines prompt ownership and tool
   pairing. Fork uses raw native records rather than the public read projection.
6. **Frozen, bounded reads.** Cursors retain selected history and identity while
   each page rechecks authorization. Budgets include structured results and the
   duplicated wire envelope; batch never rereads after a later mutation.

## Verification

Run `npm test` and `npm run format:check`. Tests use temporary native stores,
isolated agent environments and synthetic providers without credentials or paid
endpoints. CI runs both commands on Node 22 and 26 for `main` pushes and pull
requests.

Integration tests exercise submission, late acknowledgement,
automatic continuation, completion delivery and reading an earlier result after
later work. Reader tests cover selection, search and reference expansion across
Session Context, Runtime Context and isolated extension stores. Module tests live
beside their implementations under `integrations/`.

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
