# Optional plugin compatibility modules

Configured modules run with the owner's Unix access. Enable
[Intercom](../integrations/intercom/README.md) for its input mapping and Herdr
environment filter, or [Magic Context](../integrations/magic-context/README.md)
for stored summaries and project memory. Native reading works without modules.

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

The list defaults to empty. Entries accept an absolute ESM `module` path (file or directory containing `index.mjs`), `enabled` (default true) and module-specific `options` object. External modules need zero imports from Bridge internals. Disabled modules are not imported. Changes require service restart and appear in [`health.restart_required`](configuration.md#request-permission-snapshots). Duplicate paths and active module IDs reject.

After restarting, read a session that uses the extension. An applicable
session reader reports `view:"adapted"` and `reader.id`.

## Module lifecycle

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

`matches` and `read` may be asynchronous. Both receive the session's Bridge ID, canonical file, native ID and recorded cwd in `session`, live registration evidence in `owner`, parsed args in `request`, and normalized `{ range, content }` in `selection` (so external modules never import Bridge internals). The reader may also use stored evidence tied to the session. RPC hosts supply extension commands and leaf ID. SDK hosts and companions can include tool registrations.

Multiple independent readers may match the same session and compose their items and coverage automatically (with item IDs namespaced by reader ID). A reader may opt into `exclusive: true` if it cannot coexist with another reader (`SESSION_READER_CONFLICT`). Explicit `view:"session"` and `view:"runtime"` always select native sources.

## Reader content contract

`read(context)` returns `{ items, native?, coverage? }`. Each item contains:

| Field             | Meaning                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `id`              | Unique nonempty ID within this result, up to 256 characters.                            |
| `kind`            | Content kind, up to 64 characters; use the shared content names where applicable.       |
| `text`            | Full readable text for literal search and reference expansion.                          |
| `title`           | Optional short label.                                                                   |
| `preview`         | Optional concise overview shown in browse rows. Search matches it as well as `text`.    |
| `source`          | Optional bounded provenance object, at most 8192 encoded bytes.                         |
| `related`         | Optional array of up to 32 `{id,relation}` links to items in the same result.           |
| `branch_relation` | Optional `on_branch`, `off_branch`, or `unknown` for the item's native source boundary. |

Unknown kinds use the `native` content control and retain their name in
`source.content_kind`. Bridge applies kind exclusions and keeps reader ordering.
The reader owns content counts, visibility and provenance.

`coverage` accepts up to 16 `{type,selected,total,excluded?}` rows. Counts are
nonnegative safe integers. `total` describes the reader's source scope.
`selected` counts captured items before search and paging. `excluded` counts
source-rule exclusions and is at most `total - selected`.

Use `native:true` to append the authorized Session Context capture in native
order. If the reader needs ancestry facts, call
`context.nativeRead({entry_ids: ids})` with up to 10,000 IDs of at most 128
characters. It returns `entry_relations` as `on_branch`, `off_branch` or `unknown`
relative to the captured leaf. Compacted ancestors are checked through raw
parent links. Repeated calls share the one capture and must use the same
requested facts. Omitting `native:true` leaves its units out of the result.

A verified historical endpoint can supply `source_entry_id` and
`source_relation:"history_leaf"` in its provenance. Bridge issues a
`source_context` ref at that native leaf. Other extension coordinates
remain provenance as supplied.

Each fresh read selects matching readers once. Multiple non-exclusive readers compose in configuration order; conflicting `exclusive: true` matches report `SESSION_READER_CONFLICT`, and reader failures report `SESSION_READER_FAILED` (including a safe uppercase module error code in `detail` when available). Bridge rechecks native identity before returning the capture. Subsequent pages and ordinary refs use that frozen capture and recheck authorization.
