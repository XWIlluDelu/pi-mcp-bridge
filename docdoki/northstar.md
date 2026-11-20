# Northstar

## Mission

Give external agents a reliable, focused way to work with native Pi sessions. Bridge coordinates discovery, context access, task submission and steering, execution control, and session ownership across local and remote clients. Pi remains the agent and owns its native execution environment.

## Success criteria

- External agents can find relevant native Pi sessions, understand their context, delegate and steer work, observe outcomes, and manage session lifecycle through a small coherent interface.
- Existing Pi TUI, RPC, and SDK-host sessions can participate without competing writers or losing native session semantics.
- Ownership, authorization, process identity, uncertain outcomes, and lifecycle handoffs remain reliable.
- The implementation stays substantially simpler than the coordination problem it solves.

## Hard constraints

### Task-oriented MCP surface

MCP tools are designed around **external-agent tasks, not individual Pi RPC commands**.

Pi's RPC API is an implementation resource, not a checklist of tools to expose. A native Pi capability does not automatically justify a Bridge tool. Keep the MCP surface as small as possible while still supporting the important external-agent workflows.

Before adding a tool, establish that:
- a concrete external-agent workflow is materially difficult or impossible with the current interface;
- existing Bridge tools and Pi's own capabilities do not already serve it adequately;
- a separate tool improves task completion enough to justify its selection burden, schema, documentation, tests, and maintenance.

Do not add tools for API completeness, symmetry, or one-to-one RPC coverage. Prefer asking Pi to perform a native operation when that is the natural route.

Current explicit decisions:
- Do not add a dedicated session-statistics tool for token, cost, or context usage. These are not central to Bridge's control role; an agent can ask Pi to inspect them when needed.
- Do not add arbitrary-history-node forking. Session-level forking covers the important workflow; historical-node forking adds disproportionate snapshot, branch-consistency, and testing complexity.
- Do not expand the tool surface unless concrete workflows demonstrate a meaningful gap.

### Pi remains the agent

Pi owns model interaction, agent execution, tools, extensions, skills, prompt handling, and native session semantics. Bridge coordinates external access; it should not recreate Pi as another coding-agent API.

### Reliability guarantees

Simplification must preserve:
- one cooperating writer per session;
- ownership bound to verified process and native-session identity;
- uncertainty for timed-out or lost acknowledgements, with no automatic replay of potentially dispatched mutations;
- coherent request-time permission snapshots and checks at relevant admission/dispatch boundaries;
- correct stop, delete, reload, shutdown, and handoff semantics;
- branch-aware native history and coherent read snapshots, cursors, and references.

### Simplicity over completeness

Prefer fewer states, transitions, representations, and layers. Share code only when semantics genuinely match. Do not introduce generic owner abstractions, speculative compatibility layers, or one-implementation interfaces merely for symmetry.

Default to preserving user-visible behavior. Remove redundant mechanisms, not reliability guarantees. Code and tests provide evidence about current behavior; they do not independently define product requirements.
