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
to 24 hours; `ttlMs: null` is granted a finite one-hour lifetime. Refresh replaces
the signing secret when supplied; deliveries include both keys for a five-minute
rotation window. Unsubscribe uses the same name, arguments and delivery
`mode/url`, without the secret.

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
No new permission, OAuth flow or chat-routing table is introduced.

Private `stateDir/event-subscriptions.json` stores subscriptions and secrets
(mode 0600), protected by the existing service lock. Records survive restart.
Expired records cannot deliver and are pruned on the next subscription change
or in-memory load. A known expired lifetime is checked before inactive endpoint
metadata, without translating old formats. The store is not a history or a
durable delivery queue.

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
deliveries use the HTTP status only and close the unused response stream without
reading or retaining its body; response-body size cannot turn a `2xx` receipt
or a permanent refusal into a transport failure. Secrets must decode to
24–64 bytes. Requests use Standard Webhooks headers and signatures over the
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
An interruption can lose occurrences or pending deliveries. Subscription
persistence does not promise event persistence. `PI_MCP_LOG=1` enables
content-free delivery success/failure/drop diagnostics; it does not log callback
URLs, secrets, bodies or conversation content. For explicit network troubleshooting,
`PI_MCP_LOG_CALLBACK_HOST=1` additionally records only the parsed callback hostname
before verification. It never records URL paths, query strings, credentials or
headers. Remove this temporary setting after identifying the destination.

## Troubleshooting fake-IP proxy DNS

A fake-IP exception is **not a default requirement**. Leave working DNS/proxy
settings alone. This applies when a proxy such as FlClash/Mihomo returns synthetic
addresses (for example, `198.18.0.0/15`) that it would later map back to the
destination. Bridge rejects those addresses before connecting, so the proxy never
gets that opportunity.

ChatGPT may report a generic task-service “unexpected error”. In Bridge diagnostics,
the relevant failure is `events/subscribe` returning HTTP 400, JSON-RPC `-32015`
(`CallbackEndpointError`), with `callback_reason: blocked_address`. A subsequent
successful `events/unsubscribe` can be task-service cleanup, not evidence that
subscription verification succeeded. This reason alone does not establish fake-IP:
a genuinely nonpublic destination must remain blocked.

1. Use `PI_MCP_LOG=1` to correlate the request and response. If the destination is
   unknown, temporarily enable `PI_MCP_LOG_CALLBACK_HOST=1` and have the subscribing
   chat retry once. Collect only the parsed hostname, never the complete callback
   URL, query, signing secret or headers.
2. Check system DNS for that exact hostname and confirm that the local proxy is
   supplying fake-IP addresses. ChatGPT supplies the callback; do not infer its
   hostname from the plugin name or assume it is `chatgpt.com`.
3. With owner approval, append only the observed hostname to the proxy's
   **persistent, effective** `fake-ip-filter`. With Mihomo's `blacklist` filter
   mode, matching domains receive real addresses rather than fake-IP. Other modes
   have different semantics; do not change the mode as a shortcut.
4. Preserve every existing filter entry and all other DNS, routing and proxy
   settings. If the active profile or an existing extension supplies the list,
   append there rather than enabling a global override that replaces it. Do not
   edit only the generated runtime YAML. Apply through the proxy's native save/
   reload path, without disabling TUN.
5. Verify that system DNS now returns public addresses and HTTPS succeeds with
   address pinning and hostname/certificate validation intact. Then retry the
   formal subscription in the original chat; send work only after it succeeds.
   Remove the temporary hostname diagnostic setting when troubleshooting ends.

The callback observed in the verified deployment was `connectors.api.openai.com`.
For that hostname, the single item to append is:

```yaml
- connectors.api.openai.com
```

This is an observed destination, not a universal callback-domain contract. Use the
actual callback hostname in each deployment. Do **not** add `*.openai.com` or
`+.openai.com`, allow the fake-IP range through Bridge's public-address checks,
disable TLS verification, or delegate arbitrary destinations to a proxy while
skipping those checks. The exception changes the proxy's DNS answer, not Bridge's
security policy. No separate Bridge DoH resolver is required for this approach.

## First real ChatGPT acceptance

Service activation/restart and plugin changes are owner operations, not part of
a source-only update.

1. Activate the new Bridge source and dependencies together, using the existing
   owner configuration and Tunnel. Use the matching owned observer shipped with
   that source. Coordinate any interruption of in-flight work before updating.
2. Refresh/rescan the plugin. Confirm `server/discover` and `events/list` succeed
   and `session.settled` appears on the Bridge plugin and in available event sources.
3. In the intended Work chat, subscribe to an existing, idle, authorized session.
   Ask ChatGPT to read that settlement's result and report in this same chat,
   without sending more Pi work. Confirm subscribe and callback verification
   succeed **before** submitting the task.
4. Send one harmless read-only Pi task with a unique result marker. Do not send
   follow-up chat messages or poll for completion.
5. Verify all three stages: native settlement, accepted signed webhook, and
   ChatGPT's event-triggered `read` and report in the original chat.
   A webhook 2xx acknowledges receipt, not completion of the ChatGPT reaction.
6. Cancel monitoring and confirm unsubscribe. Remove temporary probes; keep no
   synthetic subscriptions or credentials as permanent fixtures.

Local tests exercise native Pi with a synthetic provider, authenticated MCP
subscription, signed receiver validation and leaf-pinned result retrieval. They
do not substitute for the ChatGPT subscription/awakening acceptance above.

Owner-confirmed production acceptance on 2026-10-22: the formal
`session.settled` event at **16:40:07 UTC** woke the original subscribing chat,
which read leaf `abb08d69` and retrieved `BRIDGE_NOTIFY_E2E_20261022_OK`.
This exercised the official callback and chat reaction, beyond the local receiver
fixture. The deployment used the exact-host fake-IP exception described above.
