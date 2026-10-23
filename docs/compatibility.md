# Optional plugin compatibility modules

Trusted owner modules share configuration and lifecycle while registering
independent input-mapping, session-reader and daemon-environment capabilities.
They run with the owner's Unix access and do not change Bridge grants or install
native Pi extensions.

## Owner configuration

```json
{
  "compatibilityModules": [
    {
      "module": "/path/to/pi-mcp-bridge/src/compatibility/intercom.mjs",
      "enabled": true
    }
  ]
}
```

The list defaults to empty. Entries accept an absolute ESM `module` path,
`enabled` (default true) and module-specific `options` object. Disabled modules
are not imported. Changes require service restart and appear in
[`health.restart_required`](configuration.md#request-permission-snapshots).
Duplicate paths and active module IDs reject.

A module exports `{id,start}`. Bridge calls
`start({id,services,onStop}, options)` once, in configuration order under its
service lock; start may be asynchronous. Register `onStop(cleanup)` immediately
after acquiring resources. Failed startup unwinds registered cleanup. Shutdown
drains writers, ACKs and release captures before cleanup runs in reverse order,
continuing after individual failures.

## Input mapping

`services.readInputs.register(id,inputCustomTypes)` returns cleanup for exact
native custom-message types. Bridge validates and sends detached descriptors
through owner IPC; only Bridge imports module code. Invalid descriptors,
duplicate IDs or overlapping types report `INVALID_READ_ADAPTER`.
[Reading](reading.md#optional-input-mappings) defines input boundaries and
source metadata.

The supplied Intercom module maps `intercom_message`. It also uses
`services.daemonEnvironment.register(filter)` to remove `PI_INTERCOM_*` identity
variables from Herdr's shared-daemon environment. Each filter mutates a detached
environment copy and registration returns cleanup. The actual Pi child retains
its launch environment. Both registrations follow module enablement/lifecycle.

## Session-specific read routing

A memory integration can register:

```js
onStop(
  services.sessionReaders.register(id, {
    matches: ({ session, owner }) => matchesSessionExtension(session, owner),
    read: readSessionContext,
  }),
);
```

`matches` and `read` may be asynchronous. Both receive:

| Field          | Meaning                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session`      | Bridge `id`, canonical `file`, native `native_id` and recorded `cwd`.                                                                                              |
| `owner`        | Registration `available`, `tools`, `commands` and native `leaf_id`. Without information: false, empty names and null leaf; this does not establish plugin absence. |
| `request`      | Parsed initial read arguments, including selection intent.                                                                                                         |
| `nativeRead()` | Authorized, sanitized native acquisition using the same arguments.                                                                                                 |

Owned RPCs, companions and SDK hosts expose native registrations. RPC hosts
expose extension commands via `getCommands()` and leaf via `getEntries()`; tools
are empty because RPC does not expose all registrations. Custom hosts can supply
`readFeatures()` with the owner fields above. Commands can identify an extension
whose tools are disabled. Without live information, matching may use session-local
persisted evidence. Each module defines valid evidence and context acquisition;
global installation alone does not establish session activation.

A match overrides the default read source, including for saved sessions. No match
uses native projection. Explicit `view:"native"` forces native acquisition and
`view:"observed"` uses the built-in capture. `preset`, `select` and `leaf_id` stay
with the selected reader: it must apply supported intent or reject it. Reading
never starts Pi.

`read(context)` returns native-shaped messages. Bridge sanitizes and pages them
as `view:"adapted"` with `reader.id`, synthetic `source.reader_index` and null native
selection counts. Modules may put provenance in message `details`.
[Read continuations](reading.md#request) freeze the capture and selection intent
without another owner probe or reader call, while rechecking authorization/identity.

Multiple matches report `SESSION_READER_CONFLICT`; reader exceptions report
`SESSION_READER_FAILED` without substituting native content. Before publication,
Bridge rechecks native identity and applicability, including an owner that
appeared during a saved read. A changed applicable reader reports
`READ_SOURCE_CHANGED`.
