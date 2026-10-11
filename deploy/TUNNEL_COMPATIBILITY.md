# Secure MCP Tunnel: stdio lifecycle compatibility

These source findings apply to the stdio child-management route. They do not
block the independently supervised [HTTP route](HTTP.md).

| Source version | Relevant behavior |
| --- | --- |
| `v0.0.16` (`5f99daab`) | Child failure can exit successfully; internal shutdown is limited to 15 seconds; completed-response posting lacks the correction below. |
| `b91e6c9` | Includes the response-post correction; the exit-status and shutdown-budget limits remain. |

## Restart and shutdown

Unexpected child exit, EOF or write failure requests Fx shutdown without a
nonzero exit code. The client does not restart that child internally, so
`Restart=on-failure` misses this path. The optional
`tunnel-restart.conf.example` uses `Restart=always`; explicit systemd stop still
stops the unit. Retain rate limiting and lock preflight, and never overlap clients
for one stdio tunnel ID. See the [stdio transport](https://github.com/openai/tunnel-client/blob/v0.0.16/pkg/mcpclient/stdio_command.go#L148-L231),
[runtime exit handling](https://github.com/openai/tunnel-client/blob/v0.0.16/pkg/runtimecli/runtimecli.go#L69-L105)
and [systemd restart rules](https://www.freedesktop.org/software/systemd/man/systemd.service.html#Restart=).

The client closes stdin, signals the child and waits within Fx's **15-second total
stop budget**, with no CLI override. `TimeoutStopSec=90` cannot enlarge that
internal budget. A Bridge send can await an ACK for 30 seconds, before accounting
for other admitted work and filesystem drainage. With `KillMode=mixed`, the
client exiting early can cause remaining Bridge/RPC descendants to be killed.
See [app options](https://github.com/openai/tunnel-client/blob/v0.0.16/pkg/app/app.go#L42-L82)
and [Fx's default](https://github.com/uber-go/fx/blob/v1.23.0/app.go#L128-L149).

This route needs a client with a sufficient internal budget, or a supervisor that
owns drainage until Bridge and its children exit. Test the selected binary with
slow admitted work, child failure and non-overlapping restart before activation.
A restart-policy change alone does not solve shutdown.

## Response delivery and activation

Require [the completed-response posting correction](https://github.com/openai/tunnel-client/commit/5ddcde0397271a375f1ecdab6eaae1aeeac4c52e)
or an equivalent verified fix. It separates a failed response POST from a local
stdio session failure. Mutation uncertainty still requires recovery with the
original request ID.

Verify account/workspace permissions, intended caller scope, tunnel routing,
runtime credentials, outbound access and post-replacement MCP initialization in
the target environment.
