# Project overview

## Architecture

External MCP clients connect over stdio (`src/server.mjs`), shared loopback HTTP (`src/http-server.mjs`), or a thin stdio-to-HTTP proxy (`src/stdio-proxy.mjs`). `src/mcp/protocol.mjs` serves both stateless per-request MCP (`2026-07-28`, including OpenAI MCP Events) and standard initialize-based MCP (`2025-11-25`–`2024-11-05`) over a 13-tool layered surface.

`src/core/bridge.mjs` takes a single receive-time permission snapshot per request (seven independent rights resolved `session > most-specific project > default`), enforces per-session lanes and fences, and coordinates reads, mutations, and local handoffs against native Pi JSONL files. At most one live writer owns a session at a time—either a Bridge-owned Pi RPC worker (directly or inside Herdr on Linux), a user's Pi TUI/RPC companion (`src/attach-extension.mjs`), or an embedded SDK/RPC host—tracked through the single-writer registry (`src/runtime/attachments.mjs`, Linux and macOS). See [[state-ownership]] for durable boundary invariants.

## Areas

- **Transports (`src/mcp/`, `src/server.mjs`, `src/http-server.mjs`, `src/stdio-proxy.mjs`)**: Dual-protocol MCP dispatch, 13 layered tools (`*_session` lifecycle, in-session verbs, Bridge utilities), batch lane ordering, exact UTF-8/wire response budgeting.
- **Core & Permissions (`src/core/`, `src/owner-permissions-extension.mjs`)**: Request-time permission snapshots, session lanes, submission receipts for late ACKs, diagnostics, and POSIX/Darwin service & registry locking.
- **Reading & External Integrations (`src/read/`, `src/compat/`, `integrations/`)**: Branch-aware native projection, literal search, ref expansion with optional MCP image blocks, frozen LRU snapshots, runtime request observation, and zero-coupling external `compatibilityModules` with composable multi-reader routing.
- **Native Runtime & Events (`src/runtime/`, `src/ops/`, `src/events/`)**: Owned Pi RPC pool, TUI/RPC companion (including remote `stop`, rename, `/bridge-join` handoff), SDK/RPC host bindings, optional Linux Herdr placement, recoverable trash, and `session.settled` webhooks alongside bounded `wait_ms` settlement waiting.
