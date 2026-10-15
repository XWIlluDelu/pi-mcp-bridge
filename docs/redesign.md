# Experience outlook

Bridge lets other agents use the owner's existing local Pi sessions through MCP.
The target is shared native execution, not a second agent environment or a
client-specific integration. This is a long-term experience
outlook, not a release acceptance checklist. It guides engineering foundations
and technical exploration; [README](../README.md) describes the current API.

## Target and current behavior

| Target experience | Current implementation / remaining work |
| --- | --- |
| Reuse native settings, authentication, tools and extensions | Cold resume uses native defaults; explicit owner overrides remain available. |
| List accessible sessions with useful running state | List returns IDs and permitted metadata. Activity requires a separate status read. |
| Read effective Context with correct input/output grouping and content selection | Native projection and precise text/section expansion work. Selection, organization and live continuation need redesign. |
| Send native, idle-only, steer or follow-up input | All four modes exist. Receipts report admission; settlement describes session activity. |
| Execute native `!command` separately from a prompt | Native bash exists for owned RPC and capable SDK/RPC hosts. Ordinary companion support needs a public host seam. |
| Stop execution, return all withdrawn inputs, retain history and the running instance | Implemented for owned RPC and capable hosts. Current stop requires `command` plus `read`; the target removes this extra authorization. |
| Create a session and send its first prompt | Creation currently makes an empty session. A combined operation must check both create and send permissions and recover partial success. |
| Delete a session | Recoverable JSONL removal exists, after confirmed writer release/exit. |
| Serialize operations within one session, run independent sessions in parallel | Public batch serializes all operations. Independent target lanes remain a design option. |
| Share one Pi instance across local and remote clients | Registered companion/host routes reuse the writer. Arbitrary existing RPC processes are not automatically discoverable or controllable. |
| Open a TUI and naturally take over after current work finishes | Manual `/bridge-join` exists; automatic native TUI entry still needs a pre-open integration. |
| Keep work running after TUI closes, if the runtime permits it | No transparent process-survival path exists. Interrupting the task is an accepted alternative when background continuation is unavailable. |
| Standard local stdio and authenticated remote Streamable HTTP | Both exist. Reconnect and long-running observation must preserve operation identity without resending uncertain actions. |

## Reading: selection and chronology

The selection unit should keep a user input with the ensuing assistant text,
thinking and tool calls/results. Select from the current effective native
projection, deduplicate overlapping selections, then return original timeline
order. Pair tool calls/results by native IDs. Steering and extension-origin work
can overlap; a chronological group is not exclusive attribution to one MCP send.

The proposed six selectors are a starting point, not a fixed schema:
merged compaction/branch summaries; latest and earliest user inputs; and
head/tail selection of their text, thinking and tool records. Zero omits a
category, a positive count bounds it, and `-1` includes all available content.
The proposal defaults to full effective Context and permits convenient presets.
A replacement must also define bounded delivery of that full selection.

Current shortcomings are concrete:

- Context pages begin at the oldest selected record. A large old log or
  checkpoint can hide the latest input and progress behind many calls.
- Overview independently samples users, assistants and tools in priority order.
  Its locators preserve sources, but its output does not preserve user-turn
  grouping or chronology.
- Cursors bind the entire session revision. Appending unrelated entries can
  invalidate continuation even on an explicitly selected old leaf.
- Callers must navigate four content views, entry/message/block/section
  selectors, JSON-fragment offsets and decoded-text offsets.
- Summary reads use the checkpoint's short summary. Richer persisted
  `systemMessage` sections require separate context/section selection.

A future read model needs coherent selection and delivery. Projection fidelity
and additional overview sampling alone do not supply that interaction.

A persisted checkpoint can include useful history/memory sections. It is still a
snapshot: transient context hooks and provider serialization may change the next
model request. Effective saved Context and the final provider payload are
different observations; neither requires replaying hooks merely to read history.

## Status, batching and operation identity

List activity can reuse existing state/settlement observations for readable
rows. Probe only the relevant page; contacting every live owner would add
unnecessary latency. Keep unknown/unsupported activity distinct from idle.
Check current activity separately from settlement; settlement is session-wide
rather than per-request completion.

Create-and-send can compose the existing durable operations. Keep the created
session if sending fails, and make same-ID replay recover that partial result.

Parallel batch needs one ordered lane per session and concurrent independent
lanes. Preserve preflight conflict detection, per-operation receipts, captured
reads and the aggregate response budget. This changes execution order, not the
meaning of admission or completion.

## Permissions and migration

The requested design has five independent permissions: read, send, command,
delete and project-only create. Session rules override project inheritance;
the local configuration and TUI menu manage those choices. Command authorizes
native shell. Create-and-send requires both create and send. Stop needs no
additional grant and returns all withdrawn inputs.

Current names differ: `command` authorizes stop, and `bash` authorizes shell.
Migration must preserve existing owners' choices: an old `command:true` is
not shell consent. Removing stop's read check also intentionally makes its
recovered queue text available without transcript-read permission. Permission names and queue-text visibility must migrate as one explicit policy;
existing grants retain their current meaning until then.

## Shared instances and natural TUI entry

Ordinary Pi loaded with the companion can share read/send with Bridge. Generic
SDK/RPC hosts can publish additional native callbacks while retaining their
existing session/client. This remains independent of any particular frontend:
do not take over another host's stdin/stdout or launch a second writer.

Two public API constraints determine the remaining work:

1. Pi opens/migrates initial `--session` files before loading extensions.
   Automatic handoff needs cooperation before that open, such as a launcher or
   upstream hook. The existing awaited `session_before_switch` route is why
   manual join starts from another TUI session.
2. Ordinary `ExtensionContext` lacks standalone native bash execution and
   cancellation. TUI abort/editor APIs can recover joined queued text; that is
   not the missing capability. `pi.exec` is not the native bash history and
   Escape path. A suitable public host seam is needed for full stop/bash.

The current join waits for admitted work, closes owned RPC through native EOF,
then switches the TUI. It leaves a persistent no-cold-reacquire marker after
local exit. Automatic return to remote cold resume needs a deliberate lifecycle
policy; it is separate from preserving a task when its process dies.
See [handoff](runtime-handoff.md) and [host integration](host-adapter.md) for
the implemented lifecycle and recovery procedures.

## External references

[Related-project research](reference-projects.md) compares Codex, OpenCode and
Pi-native projects for Context organization, host discovery, ordered execution,
reconnect and TUI handoff. It examines their assumptions and implications for
Bridge's design.

### a2a-bridge

[Rladmsrl/a2a-bridge](https://github.com/Rladmsrl/a2a-bridge/tree/decc57c31b5ee28fb87580a494be2c04d5d99244)
bridges A2A requests to webhook agents. Its useful idea is separating durable
task state from a particular connection: resubscription returns a current
snapshot followed by new events, while messages and artifacts have separate
roles.

It does not solve native Pi ownership, Context selection or TUI handoff.
Its cancel path marks a task canceled before notifying the bot; that is not
native execution-stop confirmation. Its event bus is in memory, so
resubscription is not full missed-event replay. Automatic webhook delivery
retries also cannot be applied to uncertain Pi prompts or shell execution.
