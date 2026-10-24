# Optional plugin compatibility modules

Trusted owner modules share configuration and lifecycle while registering
independent input-mapping, session-reader and daemon-environment capabilities.
They run with the owner's Unix access and do not change Bridge grants or install
native Pi extensions. Core imports only configured module paths; it contains no
plugin-specific detection or storage code. The modules under `integrations/` are
independent examples/implementations, not automatically enabled dependencies.

## Owner configuration

```json
{
  "compatibilityModules": [
    {
      "module": "/path/to/pi-mcp-bridge/integrations/intercom/index.mjs",
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

The external [Intercom module](../integrations/intercom/README.md) maps
`intercom_message`. It also uses
`services.daemonEnvironment.register(filter)` to remove `PI_INTERCOM_*` identity
variables from Herdr's shared-daemon environment. Each filter mutates a detached
environment copy and registration returns cleanup. The actual Pi child retains
its launch environment. Both registrations follow module enablement/lifecycle.

## Session-specific read routing

A content integration registers a reader through the existing module lifecycle:

```js
export default {
  id: 'example-memory',
  start({ id, services, onStop }) {
    onStop(
      services.sessionReaders.register(id, {
        matches: ({ session, owner }) => matchesSessionExtension(session, owner),
        read: async (context) => ({
          native: true,
          items: [
            {
              id: 'memory:retry-policy',
              kind: 'memory',
              title: 'Retry policy',
              preview: 'Retry only after confirming the previous result.',
              text: await readStoredPolicy(context.session),
              source: { scope: 'own_project', origin: 'extension_store' },
            },
          ],
        }),
      }),
    );
  },
};
```

The illustrative helpers above belong to the integration, not Bridge core.
`matches` and `read` may be asynchronous. Both receive:

| Field          | Meaning                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `session`      | Bridge `id`, canonical `file`, native `native_id` and recorded `cwd`.                                                   |
| `owner`        | Registration `available`, `tools`, `commands` and native `leaf_id`. Missing information is not proof of plugin absence. |
| `request`      | Parsed initial read arguments, including selection and detail intent. Search acquires the full effective source.        |
| `nativeRead()` | Authorized, sanitized native acquisition using the same arguments.                                                      |

Owned RPCs, companions and SDK hosts expose native registrations. RPC hosts
expose extension commands via `getCommands()` and leaf via `getEntries()`; tools
are empty because RPC does not expose all registrations. Custom hosts can supply
`readFeatures()` with the owner fields above. Commands can identify an extension
whose tools are disabled. Without live information, matching may use session-local
persisted evidence. Each module defines valid evidence and context acquisition;
global installation alone does not establish session activation.

A match overrides the default source for both read and search, including saved
sessions. No match uses Session Context. Explicit `view:"session"` forces native
acquisition and `view:"runtime"` uses the built-in capture. Native `preset`, `select`
and `leaf_id` stay with the selected reader: it must honor supported intent or
reject it. Reading never starts Pi or executes an extension tool to obtain data.

## Reader content contract

`read(context)` returns `{ items, native?, coverage? }`. Each item contains:

| Field     | Meaning                                                                       |
| --------- | ----------------------------------------------------------------------------- |
| `id`      | Unique nonempty ID within this result, up to 256 characters.                  |
| `kind`    | Content kind, up to 64 characters; returned as the public item `type`.        |
| `text`    | Full readable text for literal search and reference expansion.                |
| `title`   | Optional short label.                                                         |
| `preview` | Optional concise overview; a preview never replaces searchable full text.     |
| `source`  | Optional bounded provenance object, at most 8192 encoded bytes.               |
| `related` | Optional array of up to 32 `{id,relation}` links to items in the same result. |

Optional `coverage` contains up to 16 `{type,selected,total}` rows. Each type is a
nonempty content-kind string of up to 64 characters; counts are safe nonnegative
integers with `selected <= total`. `total` describes the eligible items in the
reader's declared scope, while `selected` describes items captured after its
preset selection, before response pagination or search-result filtering. Bridge
returns these rows as `reader.coverage` alongside the reader ID.

Use coverage when a default reader selects only a few summaries or memories.
Increasing the page budget cannot recover items excluded from that capture;
`recent`, `full`, or a fresh search can request a broader selection. Counts must
not imply coverage of stores, visibility scopes or content kinds the reader does
not support. Search acquires the full supported effective source; its `matches`
count is separate from reader coverage.

Set `native:true` to include the target session's current task/progress alongside
extension content. Bridge calls its authorized `nativeRead()` and combines the
cleaned units. This avoids a memory-only directory as the default session answer.
A reader providing its own complete task view may omit native content, but must
state its source and coverage clearly. Do not copy the same native units into
items and also request `native:true`.

Bridge sanitizes and segments item text, groups it for brief previews, searches the
full captured text and expands opaque references. Public reader results use
`view:"adapted"`, `reader.id` and `source.reader_item`; native units retain native
locators. When `native:true`, `selection` and `omissions.selection` describe only
the included Session Context portion. Extension content follows the reader's documented scope;
those counts do not describe its store. Without native content the counts are null. Item
IDs and refs are scoped to the capture, not permanent global identifiers.

If an item identifies a verified native historical endpoint, it can supply
`source_entry_id` with `source_relation:"history_leaf"` in `source`. Bridge exposes
a `source_context` reference that reads Session Context at that leaf. This is a
historical context boundary, not a claim that extension coordinates map to an
exact native message or block range. Other origins remain provenance metadata.

Readers own plugin storage layout, activation evidence, content structure,
visibility rules and current schema validation. Core owns authorization, routing,
cleaning, byte budgets, references and cache lifecycle. Keep independent module
capabilities independent: a reader need not provide input mappings or daemon
environment filters, and those capabilities do not require a reader.

The [Magic Context reader](../integrations/magic-context/README.md) illustrates
this contract with compartments, own-project memories and native session progress.
Its supported version, storage scope and provenance limits are documented there.

Continuations and ordinary reference expansion use the frozen capture without
another owner probe or reader call, while rechecking authorization and identity.
Multiple matches report `SESSION_READER_CONFLICT`; reader exceptions report
`SESSION_READER_FAILED` without substituting native content. Before publication,
Bridge rechecks native identity and applicability, including an owner that appeared
during a saved read. A changed applicable reader reports `READ_SOURCE_CHANGED`.
Unsupported live contracts require matching components to be updated together;
modules must not translate obsolete Bridge control formats.
