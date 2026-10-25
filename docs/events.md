# Pi completion events in ChatGPT

Bridge implements the [OpenAI MCP Events integration](https://developers.openai.com/plugins/build/mcp-events)
on MCP `2026-07-28`. ChatGPT Work chats (desktop: Cloud selected) and dots can
subscribe and react in the subscribing chat through outbound signed HTTPS webhooks.

## Scope and completion meaning

The single event is `session.settled`, filtered by one known `session_id`.
It observes Bridge-owned RPC execution, including Herdr, and ordinary TUI/RPC
companions loaded with this Bridge's owner profile. The companion derives the
local notification address from the existing owner configuration. No extra
notification configuration is needed. Subscription never starts Pi.

SDK host bindings and directory-only (`PI_MCP_ATTACH_DIR`) companions have no
completion source and reject subscription with `Unsupported / externalOwner`.
A subscription follows the saved session across supported owners, including a
native reload or handoff; work under an unsupported owner is not observed.

Pi's native `agent_settled` fires after automatic continuations finish, including
aborted runs. Settlement describes the session run, not per-prompt success. A
handled slash command that never starts a run produces no settlement.

The observer captures the leaf and a bounded last assistant response at that
boundary, before awaiting IPC. The response comes from the same native projection
as Session Context, restricted to entries after this observed run started.
Bridge verifies the current registered process, session, generation and occurrence
sequence before scheduling delivery. Once accepted, an occurrence survives normal
owner exit or switching; delivery still checks current read access. Pi waits at
most two seconds for local acknowledgement, never for HTTPS delivery. A stopped
or unreachable Bridge can lose the occurrence without interrupting local Pi work.

Subscribe **before** sending work. Monitoring continues until cancelled or expired.

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
      "preset": "latest"
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

When more detail is useful, pass `data.read` directly as the `read` tool arguments.
Its explicit `view:"session"` reads the native boundary even when an enabled
memory reader handles default reads; MC does not reconstruct historical leaves.
The leaf pins that round despite later work. A null leaf denotes an empty branch.
Deletion or revoked read access can make deeper reading unavailable. The
subscribing chat's user chooses the reaction; event payloads contain data only.

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
Bridge uses native HTTPS without explicit HTTP/SOCKS proxy support; transparent
TUN routing can provide outbound connectivity. The host needs HTTPS access to
the ChatGPT-provided callback; the incoming Secure MCP Tunnel does not make
this outbound request for it.

Delivery is bounded to ten attempts, with 1/2/4/8/16/30/60/120/120-second
backoff (361 seconds in total) and ten-second network deadlines per attempt.
Retries require Bridge to remain running and the subscription authorized and
unexpired. They keep the event ID and body, refreshing the signature timestamp.
Only transport failures, 408, 429 and 5xx retry; 410, 413 and redirects do not.
At most 32 active subscriptions and 64 pending deliveries are retained. Overflow
or exhausted delivery attempts are dropped. Incoming Tunnel reconnection does
not affect the outbound retry loop.

Polling, streaming, `gap` and `terminated` notifications are unsupported.
Interruption can lose occurrences or pending deliveries. `PI_MCP_LOG=1`
enables content-free delivery success/failure/drop diagnostics. For network
troubleshooting, `PI_MCP_LOG_CALLBACK_HOST=1` additionally records the parsed
callback hostname before verification. Neither setting logs full callback URLs,
secrets, bodies or conversation content. Remove the hostname setting when
troubleshooting ends.

## Troubleshooting fake-IP proxy DNS

`events/subscribe` can return HTTP 400 / JSON-RPC `-32015 CallbackEndpointError`
with `data.reason:"blocked_address"` when DNS resolves the callback to a
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
Update Bridge and its matching companion/observer together, coordinating any
interruption of in-flight work. Existing ordinary owners need a safe native
`/reload` or host-managed reopen to load the updated companion.

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

Local tests cover native Pi settlement with a synthetic provider, authenticated
MCP subscription, signed receiver validation and leaf-pinned result retrieval.
The workflow above also verifies delivery to ChatGPT and its reaction.
