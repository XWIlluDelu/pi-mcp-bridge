# Pi completion events in ChatGPT

Bridge implements the [OpenAI MCP Events integration](https://developers.openai.com/plugins/build/mcp-events)
on MCP `2026-07-28`. ChatGPT Work chats (desktop: Cloud selected) and dots can
subscribe and react in the subscribing chat. The transport is **outbound signed
HTTPS webhooks**, not SSE, resource updates or a long-running tool call.

## Scope and completion meaning

The single event is `session.settled`, filtered by one known `session_id`.
It observes **Bridge-owned RPC execution**, including owned RPCs placed through
Herdr. Subscription never starts Pi. An already attached external TUI, RPC or SDK
owner is rejected with `Unsupported / externalOwner`; execution after a handoff
to an external owner is outside this event's scope.

Pi's native `agent_settled` supplies the boundary after automatic continuations
finish. It is not `agent_end`, process exit, a per-prompt receipt or a claim that
the user's goal succeeded. Aborted runs also settle. A handled slash command
that never starts an agent run does not produce this event.

The owned observer captures the leaf synchronously in that native hook and sends
it through the existing private owner-control socket, with the writer generation
and monotonic occurrence sequence. Bridge checks the active owned runtime before
accepting it. The observer waits only for bounded local acknowledgement, never
HTTPS. No event is appended to native history; release and deletion protections
are unchanged.

Subscribe **before** sending work. Subscriptions monitor future settlements until
cancelled or expired; they are not implicitly one-shot.

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

ChatGPT supplies the destination and secret; do not invent a callback or put
credentials in prompts. Subscription identity is the fixed authenticated owner,
exact callback URL, event name and canonical arguments. This deployment has one
owner, not separate MCP-client accounts; `clientInfo` is not an identity.

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
    "aborted": false
  },
  "cursor": null
}
```

A null leaf denotes the empty branch. The caller reads
`read({session_id, leaf_id, preset:"latest"})`. Explicit `leaf_id` prevents a
later round from changing the selected result. Read can still fail if the
session was subsequently deleted or access revoked. Event data carries no model
instructions; the user decides the reaction in the subscribing chat.

## Authorization, storage and delivery

Event discovery and subscription use the request's receive-time permission
snapshot, including waits in the executor or subscription queue. Subscription
requires the session's `read` right. Each outbound delivery attempt takes a fresh
snapshot of scope and read permission and rechecks identity; a detected
revocation removes the subscription. Project authorization uses the native
header's recorded project identity, so workspace cleanup alone does not revoke
the subscription. The owner can unsubscribe after revocation.

Private `stateDir/event-subscriptions.json` stores subscriptions and secrets
(mode 0600), protected by the existing service lock. Records survive restart.
Expired records cannot deliver and are pruned on the next subscription change
or in-memory load, before their endpoint metadata is validated. Occurrences and
pending deliveries are held only in memory.

If the store is malformed, unreadable or nonprivate, Bridge starts with events
unavailable rather than activating a partial store or stopping core operations.
The original file is left intact; event methods cannot overwrite it and return
HTTP 500 / JSON-RPC `-32603 EventSubscriptionsUnavailable` with a content-free
`data.reason`. Unscoped `health({})` includes
`events:{status:"unavailable",reason:"…"}`, and opt-in diagnostics emit
`events.store_unavailable`. The owner repairs the file and its privacy, then
restarts Bridge to load it. Occurrences during unavailability are not replayed.

Callback consent is verified with a fresh signed challenge before activation,
and cached by owner and exact URL for five minutes. Successful verification
requires a matching challenge in a response body bounded to 4096 bytes. Ordinary
deliveries use the HTTP status only and close the unused response stream.
Secrets must decode to 24–64 bytes. Requests use Standard Webhooks headers and signatures over the
exact serialized body. Callback errors use OpenAI's documented `-32015`
`CallbackEndpointError`, with a content-free `data.reason`.

Each connection resolves DNS anew, rejects nonpublic addresses, pins the validated
address, and retains hostname-based TLS verification. No redirects are followed.
Bridge uses native HTTPS without explicit HTTP/SOCKS proxy support; transparent
TUN routing can provide outbound connectivity. The host needs HTTPS access to
the ChatGPT-provided callback; the incoming Secure MCP Tunnel does not make
this outbound request for it.

Delivery is bounded to ten attempts, with 1/2/4/8/16/30/60/120/120-second
backoff (361 seconds in total) and ten-second network deadlines per attempt.
This keeps retry opportunities open across a brief callback outage, provided
Bridge remains running and the subscription remains authorized and unexpired.
Retries keep the event ID and exact body and refresh the signature timestamp.
Only transport failures, 408, 429 and 5xx retry; 410, 413 and redirects do not.
At most 32 active subscriptions and 64 pending deliveries are retained. Overflow
or exhausted delivery attempts are dropped, not replayed. Incoming Tunnel
reconnection neither pauses nor restarts this independent outbound retry loop.

There is **no replay**, polling, streaming, `gap` or `terminated` notification.
An interruption can lose occurrences or pending deliveries. `PI_MCP_LOG=1`
enables content-free delivery success/failure/drop diagnostics. For network
troubleshooting, `PI_MCP_LOG_CALLBACK_HOST=1` additionally records the parsed
callback hostname before verification. Neither setting logs full callback URLs,
secrets, bodies or conversation content. Remove the hostname setting when
troubleshooting ends.

## Troubleshooting fake-IP proxy DNS

`events/subscribe` can return HTTP 400 / JSON-RPC `-32015 CallbackEndpointError`
with `callback_reason: blocked_address` when DNS resolves the callback to a
nonpublic address. Some proxies return synthetic fake-IP addresses, such as
`198.18.0.0/15`, which Bridge rejects before connecting.

1. Enable the diagnostics above and retry subscription to identify the callback
   hostname. Check that hostname's system DNS result and confirm whether the
   local proxy supplied a fake-IP address.
2. If confirmed, obtain owner approval to add that exact hostname to the proxy's
   persistent DNS exclusion configuration. Preserve existing entries, filter mode
   and routing settings; apply the change through the proxy's native save/reload
   path. Use the actual callback hostname rather than a wildcard domain.
3. Confirm DNS now returns public addresses, then retry subscription in the
   original chat. Keep Bridge's public-address checks, address pinning and TLS
   validation enabled. Send work after subscription succeeds.

## Verify the ChatGPT workflow

Service activation, restart and plugin changes require owner authorization.
Update Bridge, dependencies and its owned observer together, coordinating any
interruption of in-flight work.

1. Refresh/rescan the plugin and confirm that `session.settled` appears.
2. In the intended Work chat, subscribe to an authorized saved session and ask
   ChatGPT to read the settlement's result and report in that chat. Confirm
   subscription and callback verification succeed before sending work.
3. Send a harmless Pi task with a distinct result. Verify native settlement,
   webhook receipt and the event-triggered read/report in the original chat,
   without polling or prompting the chat again. A webhook `2xx` acknowledges
   receipt; the chat reaction is asynchronous.
4. Cancel monitoring and confirm unsubscribe. Remove temporary probes and
   diagnostic settings.

Local tests cover native Pi settlement with a synthetic provider, authenticated
MCP subscription, signed receiver validation and leaf-pinned result retrieval.
The workflow above also verifies delivery to ChatGPT and its reaction.
