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

A subscription receives new occurrences until cancellation or expiry. Subscribing
again after expiry starts a fresh delivery lifetime.

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

The excerpt contains the text blocks of the last assistant response from the
observed run. `result` is null if the observer missed the start or no assistant
message from this run remains in the native projection. `stop_reason` records
how Pi terminated that response.

Text preserves formatting and written links, up to 2048 UTF-16 units and a
4096-byte JSON result object. Longer text retains its beginning and end with
`truncated:true`. Pass `data.read` directly to `read` for the native history at
the observed leaf. Its explicit `view:"session"` also works when a memory reader
handles default reads. A null leaf denotes an empty branch.

## Authorization, storage and delivery

Discovery and subscription use the request's receive-time permission snapshot.
Each delivery attempt verifies current read access and the saved session's native
identity. A denied attempt removes the subscription. The owner can unsubscribe
after revocation.

The service lock protects `stateDir/event-subscriptions.json` (mode 0600),
which stores subscriptions and signing secrets across restarts. Pending deliveries
live in memory and end on shutdown. A malformed, unreadable or nonprivate store
disables events, leaves the file intact and keeps the rest of Bridge available.
Event methods return HTTP 500 / JSON-RPC `-32603 EventSubscriptionsUnavailable`.
Use the reason in `health.events` or diagnostic `events.store_unavailable` to
repair the file, then restart.

Refresh and unsubscribe run in order per subscription. Other subscriptions can
proceed during a slow verification. A receiver must echo a signed challenge in
a response of at most 4096 bytes. Bridge caches consent by owner/URL for five
minutes. Signing secrets decode to 24–64 bytes. Standard Webhooks signatures
cover the exact body. Verification failures return `-32015 CallbackEndpointError`
with a reason in `data.reason`.

Each HTTPS connection resolves DNS afresh, accepts only public addresses and
pins one while verifying TLS against the hostname. Redirects are rejected.
Transport failures and HTTP 408, 429 or 5xx responses trigger retries after
1/2/4/8/16/30/60/120/120 seconds, with a ten-second deadline per attempt.
Retries retain the event ID and body, and refresh the signature timestamp.
A 2xx acknowledges receipt. Bridge supports up to 32 active subscriptions and
64 pending deliveries. It drops excess deliveries and those that exhaust retries.

[Diagnostics](configuration.md#diagnostics) log delivery success, failure and
drops. To diagnose routing, set `PI_MCP_LOG_CALLBACK_HOST=1` to record the
hostname before verification. Remove it when troubleshooting ends.

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
