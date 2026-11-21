---
purpose: Durable state-ownership boundaries and lifetime invariants across Bridge, runtimes, and reads.
covers:
  - src/core/
  - src/read/
  - src/runtime/
  - src/events/
---

# State ownership and boundary invariants

These boundaries emerged from the `0.8.0-dev.27`–`0.8.0-dev.30` simplification passes (archived in `work/archive/2026-11-21-bridge-simplification.md`) and govern future refactoring across `src/core/`, `src/read/`, and `src/runtime/`.

## Ownership table

| Evidence | Owner and lifetime |
| :--- | :--- |
| Pending work and queued inputs | `src/core/bridge.mjs` owns the mutation ledger from registration through receipt. The promise can be absent while an input waits in a batch. Close drains work admitted before closure. |
| Ordering and exclusion | One record per active session holds independent work, Bash, Stop, and Delete lanes plus the current handoff fence. Work and automatic release serialize on the same lane; Delete holds a path gate while interrupting and draining work. |
| Retry for automatic release | The current owned runtime has one release promise and coalesces fresh idle hints. The parent checks pending work before the child atomically seals. A lost seal ACK retains the generation fence until explicit retry or confirmed exit. |
| Known native paths | Discovery indexes canonical paths by opaque `session_id`. Warm lookup rechecks canonical identity and applies the current request's scope. |
| Saved titles | `list_sessions` caches unchanged file revisions. Titles can appear later in native JSONL, and `list` can authorize a title without authorizing a history `read`. |
| Read captures | Public token entries preserve frozen pages and reference targets. The retained observation store preserves the last request-stage capture after an owner exits. Eviction keeps both policies separate, and live generation high-water marks survive eviction. |
| Completion sequences | Bridge rejects replays from the current owner after validating its claim. Native producers can exist across controller changes, so receipt ordering cannot be derived solely from producer state. |
| Submission receipts | Bounded admission records (`src/core/submissions.mjs`) keep the public `submission_id` and any matching late ACK available after owner release. The attachment registry tracks only writer ownership, never per-submission receipts. |

## Distinct safety boundaries

Do not collapse these checks into a single coarse lock or wrapper:

- **Owner selection vs. control exchange vs. native admission vs. confirmed exit**: An existing live claim blocks a new writer even if its endpoint is unusable; an idle sample cannot prevent native work from arriving before EOF (the native seal owns that decision); a ready owner can acknowledge a prompt before provider work settles; and a received reply still awaits identity validation before returning a receipt.
- **Raw forks vs. request observations vs. public read pages**: Each carries different lifetimes, payload shapes, and identity/authorization checks; consolidating read/runtime layers must preserve exact identity across dispatch awaits and preserve fragment offsets across page budgets.

On macOS the service, registry, and permission mutexes reserve the old socket
addresses as well as a shared short address. A liveness probe alone would leave
an interval in which an older process could bind the same namespace. Publish
the lock directory with its process marker already present. Recovery removes
only the marker for a confirmed dead process, so it cannot remove a successor
that has already published its own marker.
