# Background operation with a stdio access client

For an independently supervised Bridge, use [loopback HTTP](HTTP.md). This
Linux user-systemd template instead lets an authenticated foreground MCP client
own Bridge's stdio pipe:

```text
authorized callers -> access client -> stdio Bridge -> existing Pi owner
                                                   -> owned RPC worker
```

Availability requires the host, user service manager, access client and network.
A bare stdio Bridge is not a network service. The client must keep the protocol
pipe private and await Bridge exit during shutdown.

## Owner configuration and process boundaries

Prepare canonical session/project paths, grants, a dedicated state directory and
an `attachmentDir` shared with cooperating Pi owners. Use owner config mode 0600
and state/session/attachment directories mode 0700 under the same Unix user.
`deploy/check-owner.mjs` validates static file paths, permissions and existing
Bridge/registry locks prior to launch. Bridge performs dynamic runtime validation
for directories created during startup.

Cold resume defaults to an isolated Pi profile without inherited provider
credentials or enabled tools. Select `piRuntime.agentDir`, `inheritEnv`, `tools`
and `piArgs` explicitly for the service. A TUI's own environment is not recovered
when it closes; see the [runtime profile](../README.md#runtime-profile).

A live unreachable owner blocks a second writer. Stop the service and confirm
its owned workers have exited before manually opening shared storage in an
uninstrumented writer.

## Configure the access client

Choose a foreground client that owns one stdio child, surfaces startup/connection
failures, and closes input **then waits for child exit** on stop. Adapt
`stdio-server.example.json` to its schema, using the same absolute owner config
path as the unit preflight. All callers share one Bridge principal; upstream
access control must restrict them to that trust boundary.

Copy `run-client.example` to an owner-local executable and fill its paths and
arguments. Retain `exec`; do not detach the client or log protocol traffic.
Keep any environment file private (0600). If it contains client-administration
credentials, filter Pi inheritance explicitly with `piRuntime.inheritEnv`, or
separate client and Bridge via HTTP. Filtering environment does not isolate Pi
file-based authentication. Avoid credentials in CLI arguments and payload logging
to the supervisor journal.

### Secure MCP Tunnel option

The [version-specific lifecycle requirements](TUNNEL_COMPATIBILITY.md) must be
resolved before using this stdio route. For a compatible binary, configure its
profile to launch Bridge and run it with
`run --profile-file /absolute/path/to/profile.yaml`. Use one client per tunnel.
The profile schema, account/workspace permissions, credentials and tool discovery
must be checked against that binary. Pi/provider credentials and tunnel credentials
are separate. See [the service guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
and [client documentation](https://github.com/openai/tunnel-client#quick-start).

## Activate on the target host

1. Install the reviewed checkout and pinned dependencies at
   `~/.local/share/pi-mcp-bridge`, or update the unit paths. Confirm its Node path.
   Prepare `~/.config/pi-mcp-bridge/owner.json`, `run-client`, client configuration
   and any environment file.
2. Run `node deploy/check-owner.mjs /absolute/path/to/owner.json`, then the client's
   diagnostics in its service environment. Check actual MCP initialization and
   tool listing; process status alone is not readiness.
3. Review with `systemd-analyze --user verify /absolute/path/to/pi-mcp-bridge.service`.
   After owner approval, install the unit under `~/.config/systemd/user/`, run
   `systemctl --user daemon-reload`, then `enable --now pi-mcp-bridge.service`.
4. Check service status/journal and test authorized and denied requests from the
   actual caller. Full-logout survival requires a separate check; inspect
   `loginctl show-user "$USER" -p Linger`. Enabling lingering is an owner/admin
   decision. Sleep, power loss and network outage interrupt availability.

`KillMode=mixed` initially signals the foreground client. When that client exits,
systemd can kill remaining descendants without waiting for `TimeoutStopSec`.
The client must therefore drain Bridge before exiting. External Pi owners must
remain outside the service cgroup. Avoid `PrivateTmp`, which can hide shared
attachment sockets. See [systemd kill semantics](https://github.com/systemd/systemd/blob/v257/man/systemd.kill.xml#L74-L87).

## Stop and recover

Stop the service before changing its checkout/client/profile, and confirm old
Bridge/RPC processes exited before restarting. Preserve state and mutation IDs to
recover receipts rather than resend uncertain operations. Normal shutdown drains
dispatch/receipt work, not entire model completions.

The unit limits restart attempts to three in two minutes. Its read-only preflight
rejects existing locks; never add automatic lock deletion to `ExecStartPre`.
Stop the unit and confirm relevant old writers have closed before owner-managed
recovery. After correcting the cause, `systemctl --user reset-failed
pi-mcp-bridge.service` permits another attempt. Retire with `disable --now` while
preserving sessions and receipts.

Offline tests cover preflight, unit parsing and a detached fixture client's
lifetime/grant reload. Target-host checks cover actual client shutdown/reconnect,
remote authentication, systemd logout behavior and provider availability.
