# Northstar

## Mission

Give external agents a reliable, focused way to work with native Pi sessions. Bridge coordinates discovery, context access, task submission and steering, execution control, and session ownership across local and remote clients. Pi remains the agent and owns its native execution environment.

## Success criteria

- External agents across modern stateless MCP (`2026-07-28`) and standard initialize-based MCP (`2025-11-25`–`2024-11-05`) can find relevant native Pi sessions, understand their context, delegate and steer work, observe outcomes, and manage session lifecycle on Linux through a small, low-token, layered interface.
- Existing Pi TUI, RPC, and SDK-host sessions can participate without competing writers or losing native session semantics.
- Ownership, authorization, process identity, uncertain outcomes, and lifecycle handoffs remain reliable.
- Community Pi extensions that reshape context or memory plug in as standalone, zero-coupling external modules without editing Bridge core.
- The implementation stays substantially simpler than the coordination problem it solves.

## Hard constraints

### Task-oriented, low-token MCP surface

MCP tools are designed around **external-agent tasks, not individual Pi RPC commands**.

Pi's RPC API is an implementation resource, not a checklist of tools to expose. A native Pi capability does not automatically justify a Bridge tool. Keep the MCP surface small, layered (`*_session` lifecycle, short in-session action verbs, Bridge utilities), and concise in descriptions so external agents do not spend unnecessary tokens or attention on tool selection.

Before adding a tool, establish that:
- a concrete external-agent workflow is materially difficult or impossible with the current interface;
- existing Bridge tools and Pi's own capabilities do not already serve it adequately;
- a separate tool improves task completion enough to justify its selection burden, schema, documentation, tests, and maintenance.

Do not add tools for API completeness, symmetry, or one-to-one RPC coverage. Prefer asking Pi to perform a native operation when that is the natural route.

Current explicit decisions:
- Do not add a dedicated session-statistics tool for token, cost, or context usage; surfacing lightweight live `context_usage` on `list_sessions` status suffices without adding another tool.
- Do not add arbitrary-history-node forking. Session-level forking covers the important workflow; historical-node forking adds disproportionate snapshot, branch-consistency, and testing complexity.
- Keep search integrated into `read({query})` and maintenance actions grouped under `maintain_session` rather than proliferating single-purpose tools.
- Do not expand the tool surface unless concrete workflows demonstrate a meaningful gap.

### External, zero-coupling integrations

Community Pi extensions (such as memory, context-shaping, or inter-session messaging plugins) must integrate through standalone external ESM modules (`compatibilityModules`) with zero imports from Bridge internals. Multiple non-exclusive session readers compose automatically. Optional process placement such as Herdr remains supported on Linux with silent fallback to direct startup when unavailable.

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
