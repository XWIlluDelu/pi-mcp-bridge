# Intercom integration

This optional owner module registers two independent Bridge capabilities:

- `intercom_message` custom messages become input boundaries for Session Context
  selection, preserving their original role, content and details.
- `PI_INTERCOM_*` identity variables are removed from the shared Herdr daemon's
  environment. The actual Pi child keeps its native launch environment.

Bridge core does not import this module or detect Intercom automatically. Enable
it explicitly in owner configuration:

```json
{
  "compatibilityModules": [
    {
      "module": "/absolute/path/to/pi-mcp-bridge/integrations/intercom/index.mjs"
    }
  ]
}
```

Both registrations use the shared module lifecycle and are removed together on
shutdown. Disabling this module restores ordinary custom-message grouping and
leaves daemon environment selection unchanged. Configuration changes require a
Bridge restart. The module does not install or start the native Pi extension.

Run its isolated lifecycle test with:

```sh
node --test integrations/intercom/index.test.mjs
```
