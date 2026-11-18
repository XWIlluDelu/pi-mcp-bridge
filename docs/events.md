# Pi completion events in ChatGPT

Bridge implements the [OpenAI MCP Events integration](https://developers.openai.com/plugins/build/mcp-events)
on MCP `2026-07-28`. ChatGPT Work chats (desktop: Cloud selected) and dots can
subscribe and react in the subscribing chat through outbound signed HTTPS webhooks.

## Before subscribing

- Connect ChatGPT to the authenticated Bridge endpoint using the
  [transport setup](transports.md).
- Obtain the target's `session_id` and grant `read`. Sending work separately
  requires `send`; subscription does not grant execution access. For a new task,
  `create` without input gives you a saved ID to subscribe to before the first send.
- Connect a [supported owner](#scope-and-completion-meaning).
- Allow outbound HTTPS from the Bridge host to the ChatGPT-provided callback.
  An authenticated incoming tunnel does not provide this outbound connection.

The normal order is **subscribe, confirm verification, send, receive, unsubscribe**.
The [calling workflow](collaboration.md#calling-workflow) explains when the
settlement excerpt is sufficient and when to read further.

## Scope and completion meaning

The single event is `session.settled`, filtered by one known `session_id`.
It follows a saved session across Bridge-owned RPCs and ordinary TUI/RPC
companions loaded with this Bridge's [owner profile](runtime.md#daily-tui-and-ordinary-rpc-registration).
SDK/RPC host bindings and directory-only companions reject subscription with
`Unsupported / externalOwner`. Subscribing leaves Pi idle or running as it was.

Pi's native `agent_settled` fires after automatic continuations finish, including
aborted runs. Settlement describes the session run, not per-prompt success. A
handled slash command that never starts a run produces no settlement.

The observer captures the leaf, recorded native project identity and a bounded
last assistant response at that boundary, before awaiting IPC. The response comes
from the same native projection as Session Context, restricted to entries after
this observed run started. Bridge verifies that identity against the saved session,
along with the registered process, generation and occurrence sequence, before
scheduling delivery. Once accepted, an occurrence survives normal
owner exit or switching; delivery still checks current read access. Pi waits at
most two seconds for local acknowledgement, never for HTTPS delivery. A stopped
or unreachable Bridge can lose the occurrence without interrupting local Pi work.

Subscription has no catch-up delivery for work that already settled. Monitoring
continues until cancelled or expired.

## Protocol

`server/discover` advertises `capabilities.events: {}`. These methods use the
same authenticated MCP endpoint, per-request metadata and HTTP headers as tools:

- `events/list`: the event definition and its input/payload schemas; no pagination.
  The catalog is empty when no in-scope saved session is readable.
- `events/subscribe`: verify the callback, then create or refresh a subscription.
- `events/unsubscribe`: idempotently stop the matching subscription. It does not
  stop Pi, and cannot retract a webhook already received by ChatGPT.

Example subscribe params (include the protocol `_meta` from [transports](transports.md)):

```json
{
  "name": "session.settled",
  "arguments": { "session_id": "ps_0123456789abcdef0123456789abcdef" },
  "delivery": {
    "mode": "webhook",
    "url": "https://CHATGPT-PROVIDED-CALLBACK",
    "secret": "whsec_CHATGPT_PROVIDED_BASE64_KEY"
  },
  "cursor": null
}
```

ChatGPT supplies the callback and secret. Subscription identity combines the
deployment's authenticated owner, exact URL, event name and canonical arguments.
`clientInfo` does not create a separate owner identity.

Subscribe returns `id`, finite `refreshBefore`, `cursor: null` and
`truncated: false`. Default lifetime is one hour. Positive `ttlMs` is honored up
to 24 hours; `ttlMs: null` is granted a finite one-hour lifetime. Every subscribe
or refresh request requires the signing secret. If a refresh changes it,
deliveries include both keys for a five-minute rotation window. Unsubscribe uses
the same name, arguments and delivery `mode/url`, without the secret.

Example delivery:

```json
{
  "eventId": "evt_...",
  "name": "session.settled",
  "timestamp": "2026-10-22T12:00:00.000Z",
  "data": {
    "session_id": "ps_0123456789abcdef0123456789abcdef",
    "leaf_id": "native-entry-id",
    "aborted": false,
    "result": {
      "entry_id": "native-assistant-entry",
      "text": "Report saved to reports/check.md.",
      "stop_reason": "stop",
      "truncated": false
    },
    "read": {
      "session_id": "ps_0123456789abcdef0123456789abcdef",
      "view": "session",
      "leaf_id": "native-entry-id",
      "range": { "recent": 1 }
    }
  },
  "cursor": null
}
```

The excerpt can be enough to report a short outcome without another tool call.
`result` is null when no current-run assistant remains in the native projection
or the observer did not see the run start. It never substitutes an earlier run's
answer. Only the last assistant's text blocks are included; an empty/error final
response does not fall back to earlier prose. `stop_reason` is that message's
native termination reason, not a claim that the user's task succeeded.

Text preserves its formatting and written links, up to 2048 UTF-16 units and a
4096-byte JSON result object. Longer text retains its beginning and end with
`truncated:true`. No model generates a summary; no files are discovered, opened,
uploaded or verified from paths in the text.

Pass `data.read` directly to `read` for more detail. Its explicit
`view:"session"` selects the historical native leaf even when a memory reader
handles default reads. A null leaf denotes an empty branch. Reading still
requires access to the saved session.

## Authorization, storage and delivery

Discovery and subscription use the request's receive-time permission snapshot.
Subscription requires `read`; each delivery attempt refreshes scope/read checks
and validates session identity. Revocation removes the subscription. Project
grants follow the recorded native project identity, including after workspace
cleanup. The owner can always unsubscribe after revocation.

Private `stateDir/event-subscriptions.json` stores subscriptions and secrets
(mode 0600), protected by the existing service lock. Records survive restart.
Expired records cannot deliver and are pruned on load or subscription changes.
Occurrences and pending deliveries are held only in memory; there is no replay.

A malformed, unreadable or nonprivate store disables events while core operations
remain available. Event methods leave the file intact and return HTTP 500 /
JSON-RPC `-32603 EventSubscriptionsUnavailable` with a content-free `data.reason`.
Health reports `events:{status:"unavailable",reason:"…"}`; diagnostics emit
`events.store_unavailable`. Repair the file/privacy and restart to reload it.

Callback verification sends a signed challenge and requires a matching response
of at most 4096 bytes. Verification is cached by owner/URL for five minutes. Secrets decode to
24–64 bytes. Standard Webhooks signatures cover the exact serialized body.
Delivery acknowledges HTTP status only. Verification failures return `-32015 CallbackEndpointError` with a content-free
`data.reason`.

Each connection resolves DNS anew, rejects nonpublic addresses, pins the validated
address, and retains hostname-based TLS verification. No redirects are followed.
Bridge uses direct native HTTPS. Transparent TUN routing can provide outbound
connectivity.

Delivery is bounded to ten attempts, with 1/2/4/8/16/30/60/120/120-second
backoff (361 seconds in total) and ten-second network deadlines per attempt.
Retries require Bridge to remain running and the subscription authorized and
unexpired. They keep the event ID and body, refreshing the signature timestamp.
Only transport failures, 408, 429 and 5xx retry; 410, 413 and redirects do not.
At most 32 active subscriptions and 64 pending deliveries are retained. Overflow
or exhausted delivery attempts are dropped. Incoming Tunnel reconnection does
not affect the outbound retry loop.

Polling, streaming, `gap` and `terminated` notifications are unsupported.
Interruption can lose occurrences or pending deliveries. With
[Bridge diagnostics enabled](configuration.md#diagnostics), delivery logs report
success, failure and drops. For network troubleshooting, also set
`PI_MCP_LOG_CALLBACK_HOST=1` in the launch environment to record the parsed
callback hostname before verification. Full callback URLs and secrets remain
excluded. Remove the hostname setting when troubleshooting ends.

## Troubleshooting fake-IP proxy DNS

`events/subscribe` can return HTTP 400 / JSON-RPC `-32015 CallbackEndpointError`
with `data.reason:"blocked_address"` when DNS resolves the callback to a
nonpublic address. Some proxies return synthetic fake-IP addresses, such as
`198.18.0.0/15`, which Bridge rejects before connecting.

Identify the callback hostname with the diagnostics above and check the system
DNS result. If a local proxy supplied a fake IP, add the exact hostname to its
persistent DNS exclusions and reload the proxy. Confirm DNS returns public
addresses, then retry subscription in the original chat.

## Verify the ChatGPT workflow

1. Refresh/rescan the plugin and confirm that `session.settled` appears.
2. In the intended Work chat, subscribe to an authorized saved session and ask
   ChatGPT to read the settlement's result and report in that chat. Confirm
   subscription and callback verification succeed before sending work.
3. Send a harmless Pi task with a distinct result. Verify native settlement,
   webhook receipt and the event-triggered report in the original chat, using
   the excerpt or `data.read` when more context is needed, without polling or
   prompting the chat again. A webhook `2xx` acknowledges
   receipt; the chat reaction is asynchronous.
4. Cancel monitoring and confirm unsubscribe. Remove temporary probes and
   diagnostic settings.
