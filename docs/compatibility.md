# Optional plugin compatibility modules

Modules share registration, owner configuration, loading and lifecycle. Their
capabilities and processing paths remain independent.

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

The list defaults to empty. Each entry has an absolute ESM `module` path,
optional `enabled` (default `true`) and module-specific `options` object.
Disabled modules are not imported. Changes take effect on a normal service
restart; health reports pending changes as `restart_required`.

A module exports `{id, start}`. Its synchronous/asynchronous
`start({id, services, onStop}, options)` runs once during Bridge startup.
Register cleanup with `onStop(callback)` immediately after acquiring a resource.
Bridge starts modules in configuration order under its service lock. Partial
startup unwinds registered cleanup. Shutdown drains writers, ACKs and release
captures before running cleanup in reverse order, continuing after an individual
cleanup failure. Duplicate paths and active module IDs are rejected.

Modules are trusted owner code with the owner's Unix access. They do not change
Bridge grants or replace native Pi's own extension installation/configuration.

## Input mapping

`services.readInputs.register(id, inputCustomTypes)` returns cleanup for exact
native custom-message input types. Bridge sends detached descriptors through
existing read IPC; owner processes do not import module code.

The supplied `src/compatibility/intercom.mjs` makes `intercom_message` an input
boundary for native `latest`/`recent` and subsequent response selection. It
preserves the custom role, source IDs, attachments and business details. It also
uses `services.daemonEnvironment.register(filter)` to remove `PI_INTERCOM_*`
identity variables from Herdr's shared-daemon environment. The actual Pi child
keeps its native launch environment. Both registrations share module enablement
and cleanup.

## Session-specific read routing

A memory integration registers its own reader under the same lifecycle:

```js
onStop(
  services.sessionReaders.register(id, {
    matches: ({ session, owner }) => matchesSessionExtension(session, owner),
    read: readSessionContext,
  }),
);
```

`matches` and `read` may be asynchronous. The context contains:

- `session`: Bridge ID, canonical `file`, native `native_id` and `cwd`.
- `owner`: `available`, current registered `tools`, `commands` and native `leaf_id`.
  Without registration information, `available` is false, names are empty and
  `leaf_id` is null. This describes observation availability, not plugin absence.
- `request`: the parsed initial read arguments, including selection intent.
- `nativeRead()`: the existing authorized, sanitized native snapshot acquisition.

Bridge obtains tool/command names from the target live owner, not from globally
installed packages. Owned RPCs, companions and SDK host bindings expose native
registration information. RPC host bindings use public `getCommands()` for extension
command names and `getEntries()` for the leaf; they do not infer all registered tools
from the model's active tool list. Custom hosts can supply `readFeatures()`
with `{available,tools,commands,leaf_id}`. Module code decides which registrations
identify its extension; reading context remains the module's own implementation.
Tools disabled for model use do not imply that a memory extension is unloaded,
so command registrations are also available. Without live registration information,
the module may use session-local persisted evidence of its extension's activation.
Bridge still invokes matching and does not infer activation from global installation
or require a live owner. The module determines what evidence is valid for its extension.

External agents continue to call `read({session_id,max_bytes})`. A matching
reader overrides default native acquisition for that session, including saved
sessions. No match uses native reading. Reading never starts Pi.
Only explicit `view:"native"` forces native projection; `preset`, `select` and
`leaf_id` do not choose a source. The selected reader handles that selection intent
through `request` and can reuse `nativeRead()`, which receives the same arguments.
A reader must apply supported selection intent or reject it, not silently ignore it.
Explicit `view:"observed"` retains its native capture semantics.
Callers need not identify a plugin to choose the default source.

`read(context)` returns an array of native-shaped messages. Bridge sanitizes,
segments and budgets them as frozen `view:"adapted"` pages with `reader.id` and
`source.reader_index`; it does not invent native entry IDs for synthetic context.
The module can retain its own provenance in message `details`. Adapted pages
have no native selection counts. Continue with the cursor alone; repeated selection
arguments must match the captured request intent. No new owner probe or adapter
execution occurs on later pages. Cursor requests still check current read
authorization and native identity.

Matching more than one reader reports `SESSION_READER_CONFLICT`. Reader errors
report `SESSION_READER_FAILED`, without silently substituting another context.
Bridge rechecks native session identity and reader applicability before publishing a
capture, including live registration information that becomes available during a saved read; a removed/replaced source reports `READ_SOURCE_CHANGED`.

Native history projection and `context_with_system`/observed capture remain
plugin-independent. The routing path is verified with an isolated memory
extension; its fixture format does not define Magic Context content selection.
