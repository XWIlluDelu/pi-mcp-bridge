---
specs: []
scope:
  - src/bridge.mjs
  - src/rpc.mjs
  - src/attachments.mjs
  - src/companion.mjs
  - src/host-adapter.mjs
  - src/host-bindings.mjs
  - src/context-read.mjs
  - src/read-navigation.mjs
  - test/
status: active
---


# Bridge simplification

**Review basis:** `auto-dev` at `b3c6ed97a49bdf4b608f2c823aafd1f51f14214a` (2026-11-20).  
**Objective:** Simplify the existing Bridge implementation without expanding its MCP tool surface or changing user-visible behavior. This work record carries the audit findings, current gaps, and next actions. Candidates below are hypotheses until verified against behavior and invariants.

## Assessment

The product's core positioning is sound: Bridge gives external agents controlled access to native Pi sessions for discovery, reading, task submission and steering, execution control, lifecycle management, and coordination with existing Pi owners.

The tool surface is already sufficient and may be slightly larger than ideal. Do not add tools for session statistics, arbitrary-history-node forking, or RPC completeness. See [Northstar](../northstar.md) for the governing product principle.

The next phase should focus on reducing duplicated state, coordination paths, data transformations, low-value test duplication, and unnecessary optional scope while preserving user-visible behavior and reliability guarantees.

## Scope and priorities

### 1. Bridge lifecycle and operation coordination

**Primary file:** `src/bridge.mjs` (about 1,265 lines at the reviewed revision).

Audit the interaction among:
- `pendingMutations`
- `locks`
- `handoffs`
- `inputs`
- `autoReleases`
- `sessionFiles`
- `titleCache`
- `completionSequences`
- `readCache`
- `submissions`

These states have different meanings; do not merge them merely because they coexist. Trace each public operation (send, command, stop, compact, reload, set_model, create, delete) through permission snapshot, input registration, serialization lane, handoff checks, native dispatch, receipt/outcome, and cleanup.

Look for:
- repeated admission or handoff checks that do not protect a distinct asynchronous boundary;
- multiple coordination layers encoding the same exclusion;
- state retained only for an obsolete path;
- repeated error/result conversion;
- caches whose contents can be derived safely and cheaply from an authoritative source.

Do not collapse Stop or Delete into an ordinary session lock. They need distinct behavior to interrupt or fence work. Keep revalidation that protects a real await/dispatch boundary.

This is the strongest candidate for substantial net deletion, potentially several hundred lines. Treat that as a hypothesis, not a quota.

### 2. Owner-path duplication

**Primary files:** `src/rpc.mjs`, `src/companion.mjs`, `src/host-adapter.mjs`, `src/host-bindings.mjs`, `src/attachments.mjs`.

The Bridge-owned RPC, ordinary Pi companion, and external SDK/RPC host are genuinely different environments. Preserve those distinctions.

Compare repeated implementations of model selection, compaction, reload admission, mutation tracking, identity validation, and result normalization. Existing shared modules such as `set-model.mjs`, `prompt-input.mjs`, `stop-execution.mjs`, `compact.mjs`, and `reload-admission.mjs` are useful where the contracts really match.

Do not introduce a generic owner abstraction with many capability flags. Share behavior only when semantics and contracts are the same; keep native-specific behavior local.

### 3. Native read and projection pipeline

**Primary files:** `src/context-read.mjs` (about 968 lines), `src/read-navigation.mjs` (about 406 lines), `src/read-cache.mjs`, `src/read-schema.mjs`, `src/session-readers.mjs`.

Preserve:
- native Session Context projection;
- turn/range and content selection;
- branch-aware navigation;
- tool call/result pairing;
- literal search and reference expansion;
- stable pagination and frozen snapshots;
- runtime context observation and transient live output.

Investigate:
1. repeated text extraction, message cleaning, or navigation-document construction across read/search paths;
2. response splitting and budget fitting that repeatedly transform the same payload;
3. unclear ownership of transformations across capture, snapshot, cache, and render;
4. cached data already represented by another authoritative state.

Prefer a pipeline that captures and normalizes once where necessary, preserves a stable snapshot, renders according to the response budget, and continues from captured state without reparsing native history.

Do not merge distinct observers just because they expose runtime information. Final settlement, extension events, live assistant output, and request-stage context have different sources and timing boundaries.

### 4. Optional integration scope

**Areas:** `integrations/`, `src/compatibility.mjs`, `src/compatibility-services.mjs`.

Keep the small, data-oriented integration boundary. Assess whether Intercom and Magic Context belong as examples or separately maintained integrations rather than core product scope. Preserve independently useful reader/input contracts.

Keep Herdr support if it remains a supported runtime placement. Do not move code merely to reduce repository LOC if doing so creates packaging, versioning, or release machinery. Do not turn the integration boundary into a general plugin framework.

## What not to simplify away

These mechanisms protect actual product behavior and should remain unless a demonstrably simpler implementation preserves the same guarantees:

- ownership and identity: process start/boot identity, native Session identity, generation binding, registry coordination, and one-writer enforcement;
- uncertain outcomes: ACK tracking, late acknowledgements, submission receipts, and no automatic replay of potentially dispatched mutations;
- permission boundaries: request-time policy snapshots and checks at relevant admission/dispatch points;
- lifecycle correctness: shutdown draining, handoff, explicit release, deletion fencing, and native process-exit confirmation;
- read correctness: branch provenance, frozen snapshots, bounded cursors/references, and authorization rechecks;
- native integration: real Pi behavior at TUI/RPC/SDK boundaries.

Do not treat PID equality as proof of shared ownership, a timeout as proof of failure, or a passing test as proof that the tested behavior is a user requirement.

## Test simplification

The reviewed tree contained 82 `*.test.mjs` suites and 31 fixture modules. Test source bytes slightly exceeded production source bytes. This motivates an audit of marginal test value, not a target test-to-source ratio.

| Test class | Policy |
|---|---|
| Ownership, identity, and concurrent writer invariants | Keep |
| Shutdown, handoff, release, and deletion races | Keep |
| Permission and dispatch-boundary races | Keep |
| ACK uncertainty and late receipt behavior | Keep |
| Native history projection, branches, cursors, frozen reads | Keep |
| Important real Pi TUI/RPC/SDK integration paths | Keep |
| HTTP/stdio protocol and response bounds | Keep |
| Optional real-Herdr environment tests | Keep opt-in |
| Trivial formatting, constants, and mapping tests | Merge/remove when integration coverage suffices |
| Repeated scenarios proving the same invariant | Consolidate |
| Tests coupled to private implementation details without a behavioral guarantee | Prefer deleting |

### Auto-release coverage gap

The reviewed tree no longer contains `test/auto-release.test.mjs`, while `src/auto-release.mjs` remains production code. The remaining direct exercise of `scheduleAutoRelease` is inside the real-Herdr opt-in portion of `test/herdr-runtime.test.mjs`. Ordinary `npm test` therefore lacks focused default coverage of the auto-release lifecycle.

Add a small default test covering:
- eligible idle owned runtime is released;
- pending acknowledgements prevent premature release;
- a definite busy refusal can be reconsidered after a later idle candidate;
- uncertain shutdown does not release ownership or incorrectly reopen admission.

Do not restore the former large test file wholesale. Keep the smallest tests that establish these externally relevant guarantees.

### Fixture audit

Inspect one-use wrappers and helpers that only forward arguments or duplicate nearby setup. Inline genuinely one-off fixtures; retain shared fixtures that express a real native environment or invariant. Avoid building a test framework of its own.

## Code-size expectations

The previous review estimated production code at roughly 10,000–12,000 LOC and proposed 7,000–9,000 LOC as a reasonable destination for this product scope.

These are estimates, not measured acceptance thresholds. Measure exact LOC before and after using one consistent method. A 20–30% reduction is worth exploring, but correctness and conceptual simplicity outrank the number. If remaining code is necessary to preserve native behavior and lifecycle guarantees, keep it.

Do not target the size of a simple Pi wrapper: this project also supports existing-session access, multiple owner types, read projection, permissions, events, and single-writer lifecycle coordination.

## Release readiness

The reviewed `auto-dev` head was `b3c6ed97a49bdf4b608f2c823aafd1f51f14214a`.

At review time:
- `.github/workflows/ci.yml` was configured for pushes to `main` and pull requests targeting `main`, not direct pushes to `auto-dev`;
- the reviewed auto-dev head had no associated workflow runs or commit status checks;
- Node 22/26 CI coverage was configured, but that did not establish that this head passed it.

Before release:
1. Ensure the release candidate receives the full CI checks.
2. Run `npm test` and `npm run format:check`.
3. Run real-Pi integration tests with the supported Pi CLI configured (see `docs/architecture.md`).
4. Run opt-in real-Herdr checks only where the required environment is available.
5. Verify installation and configuration from a clean environment.
6. Ensure README explains the product boundary, first-use path, owner permissions, and deployment modes.
7. Prefer a source-based GitHub release before adding package-registry machinery solely for distribution.

A public preview can follow successful verification. Broad promotion should wait until clean installation and the main supported owner paths have been exercised.

## Next actions

### Phase A — Establish a trustworthy baseline
- Record the exact branch head.
- Run and record full CI-equivalent checks.
- Measure source/test LOC consistently.
- Identify normal and opt-in native integration test commands.

### Phase B — Lifecycle and state audit
- Trace public operations and their state transitions.
- Identify duplicate state and redundant checks.
- Map each proposed deletion to the behavior/invariant it preserves.
- Implement the highest-confidence deletions first.

### Phase C — Owner and read-path audit
- Compare equivalent owner operations side by side.
- Remove duplicated logic only where contracts match.
- Trace read capture → projection → cache → render and remove repeated transformations.

### Phase D — Test and optional-scope audit
- Classify tests by invariant, integration behavior, or implementation detail.
- Consolidate duplicate scenarios and one-use fixtures.
- Restore focused default auto-release coverage.
- Decide optional integration scope without adding packaging complexity.

### Phase E — Release preparation
- Run relevant verification.
- Review user-visible behavior and tool schemas for unintended changes.
- Update README and release instructions.
- Summarize net source/test LOC changes and preserved guarantees.

## Acceptance criteria

- The MCP tool surface has not grown for completeness' sake.
- No existing user-facing workflow or permission meaning changes unintentionally.
- One-writer, identity, ACK uncertainty, shutdown, deletion, and read-snapshot guarantees remain intact.
- Redundant states, transitions, transformations, tests, and fixtures are removed where evidence supports deletion.
- The ordinary test run covers auto-release's essential lifecycle behavior.
- The release candidate has actual CI evidence, not merely configured workflows.
- The code is measurably smaller or materially simpler to understand and maintain.

The goal is not a smaller number at any cost. It is the same useful Bridge with fewer mechanisms to understand, fewer states to keep consistent, and less code to maintain.
