---
specs: []
scope:
  - src/
  - integrations/
  - test/
  - docs/architecture.md
  - .github/workflows/ci.yml
status: ready-for-review
---

# Bridge simplification

Preserve the external-agent workflows in [Northstar](../northstar.md). The
original review inspected `b3c6ed9` and is available in Git at `578f7de`.
The first implementation started from `5dc7c53`. The initial deletion pass
started at `0eb95b7`. The follow-up started at `e779cb2`, with a clean
`auto-dev` working tree. These are measurement points from before the local
history was regrouped.

## Results

Counts use physical lines from `bytes.splitlines()` on repository `.mjs`
files, including comments and blank lines. The test total includes fixtures.
Optional integrations have a separate total.

| Measure | Initial baseline | Follow-up baseline | `0.8.0-dev.27` | Follow-up change |
| --- | ---: | ---: | ---: | ---: |
| Production lines in `src/` | 13,367 | 13,111 | 13,005 | −106 |
| Test lines in `test/` | 15,283 | 15,075 | 15,056 | −19 |
| Production modules | 74 | 73 | 73 | 0 |
| Test suites in `test/` | 82 | 79 | 79 | 0 |
| Fixture modules | 31 | 31 | 31 | 0 |
| Integration lines, including tests | 746 | 746 | 746 | 0 |
| Integration modules and suites | 2 + 2 | 2 + 2 | 2 + 2 | 0 |

The two deletion passes removed 362 production lines in total. The follow-up
replaced independent session lane and handoff maps with one record per active
session. Create and Send use the same submission receipt path, and idle handoff
uses the same reservation path as writer startup. Owned RPC keeps outstanding
commands and received late ACK handlers in the same ledger. A missing ACK keeps
its admission fence, and shutdown drains the receipt work it has received.

Saved, runtime, and live reads use the same assistant block classification.
Source pages use one fragmentation routine for message fields, assistant blocks,
and summary parts. Search walks documents in source order and can select a
matching nested operation before expanding its parent. Three ownership suites
reuse one idle child fixture for tests that require a real, distinct PID.

The production count remains above the 7,000–9,000 line exploration target.
A shared host and companion mutation dispatcher added code around their
different admission hooks. A shared Unix socket client added options for
half-close, pre-write authorization, partial replies, and transport errors.
Both attempts were discarded. The largest unresolved reduction is a concrete
replacement of an entire ownership or Read pipeline.

## Deletion map

The audit used the import and caller inventory for every production module and
the scenario and consumer inventory for all test suites and fixtures. The
following candidates had the strongest combination of impact and confidence.

| Rank | Area | Implemented change and retained boundary |
| --- | --- | --- |
| 1 | Bridge admission and shutdown | A mutation record carries the queued input fence and its work promise. Stop withdraws matching records, including batch items waiting for policy or a prior item. The normal session lane carries automatic release through EOF. Stop and Delete keep separate lanes so they can reach an admitted writer. Local release and handoff share the fence and drain an already admitted Stop. |
| 2 | Native reads and response budgets | One branch walk supplies ancestry and distances for read, retained observations, and fork. Saved and runtime captures share assistant block classification. Runtime capture constructs the sanitized source units directly. Page sizing reuses the size of fixed metadata and charges punctuation, UTF-8 bytes, and MCP's escaped text copy separately from item data. Both capture stores use the same bounded eviction logic. |
| 3 | Owners and transport | Runtime acquisition reuses the same claim lookup for deciding between a live owner and a cold start. Attached clients use the registry to establish liveness. The SDK host uses one ledger to drain operations after disconnect and track the active native lanes. Owners share read projection, framing, and receipt validation where the contracts coincide. Model changes share the native selection sequence while owned RPC retains its ACK and idle checks. |
| 4 | Service and configuration | Stdio and HTTP share the process startup and shutdown sequence. Stdio uses one ledger for admitted requests and pending writes. Owner control uses its existing operation ledger for handoff cancellation. Native JSONL, Unix IPC and stdio share the LF framer. Configuration and observation metadata use the existing schema library for shape checks. |
| 5 | Test duplication | Retired the standalone shutdown-error, ordinary companion RPC, and LF suites. Their independent outcomes, companion workflow and frame boundaries are exercised by the batch, native startup, stdio and owner IPC suites. Reused one real RPC launch fixture across companion and host tests, and inlined the one-use partial reply fixture. Kept the default real-Pi cases for idle release, a pending prompt ACK, retry after definite busy, and retention after an uncertain seal. |
| 6 | Optional integrations | Herdr workers have one preflight path and one teardown path for channels, pane and temporary files. Kept the named isolated daemon, process identity and scoped termination. Intercom and Magic Context remain in the repository under the optional loader. Their input descriptors, reader selection and Herdr environment filters serve separate consumers. |

## State ownership

| Evidence | Owner and lifetime |
| --- | --- |
| Pending work and queued inputs | Bridge owns the mutation ledger from registration through receipt. The promise can be absent while an input waits in a batch. Close drains work admitted before closure. |
| Ordering and exclusion | One record per active session holds independent work, Bash, Stop, and Delete lanes and the current handoff fence. Work and automatic release serialize on the same lane. Delete holds a path gate while it interrupts and drains work. |
| Retry for automatic release | The current owned runtime has one release promise and coalesces fresh idle hints. The parent checks pending work before the child atomically seals. A lost seal ACK retains the generation fence until explicit retry or confirmed exit. |
| Known native paths | Discovery indexes paths by opaque session ID. Warm lookup rechecks canonical identity and applies the current request's scope. Native IDs and directory enumeration cannot supply a path from an opaque ID without this lookup. |
| Saved titles | List caches unchanged file revisions. The title can appear later in native JSONL, and list can authorize a title without authorizing a history read. |
| Read captures | Public token entries preserve frozen pages and reference targets. The retained observation store preserves the last request-stage capture after an owner exits. Eviction keeps the two retention policies separate, and live generation high-water marks survive eviction. |
| Completion sequences | Bridge rejects replays from the current owner after validating its claim. Native producers can still exist across controller changes, so deriving receipt ordering from producer state would lose evidence of delivery. |
| Submission receipts | Bounded admission records keep the public submission ID and a matching late ACK available after owner release. The registry establishes who can write and has no per-submission record. |

The current owner selection, control exchange, native admission, and confirmed
exit are separate checks. An existing live claim can block a new writer even
if its endpoint is unusable. An idle sample cannot prevent native work from
arriving before EOF. The native seal owns that final decision. A ready owner
can acknowledge a prompt before its provider work settles. A received reply can
still await identity validation before a receipt is returned. The request
ledger, ACK ledger, and native settlement evidence each cover one of these
boundaries.

The largest remaining bodies are owned RPC and the attachment registry and
transport, followed by native projection and read rendering. Owned, companion
and host runtimes expose different native evidence for admissions and exits.
Raw forks, request-stage observations and public read pages require different
lifetimes and payloads. Repeated conversions of native owner state and the
separate preview and source representations remain candidates for deeper
work. Any consolidation must carry exact identity across dispatch awaits and
preserve fragment offsets when the page budget changes.

## Verification

- At `0.8.0-dev.27`, `npm test` passed 388 tests and skipped one opt-in case
  on each of Node 22.23.5 and 26.13.1 with real Pi 1.5.2. The explicit Herdr run
  passed all four cases on Node 26.
- Compared with `e779cb2`, all 15 MCP tool definitions, 147 rendered pages,
  and 36 search results matched. The read comparison included mixed output
  budgets across continuations, Unicode, JSON escaping, and live snapshots.
- Clean source copies passed `npm ci --no-audit --no-fund`,
  `npm run format:check`, and `npm test` on Node 22.23.5 and 26.13.1 using
  the selected external Pi 1.5.2. Each default run passed 388 tests and skipped
  one real Herdr case. They covered empty-store stdio, HTTP, native TUI, owned
  and external RPC, and SDK host workflows.
- `BRIDGE_TEST_HERDR="$(command -v herdr)" node --import ./test/fixtures/pi-installation.mjs --test test/herdr-runtime.test.mjs`
  passed all four cases on Node 26 with the same Pi. The test used a named
  temporary daemon and isolated session storage.
- The Node 22 rerun confirmed the host replacement check using the normal ACK
  deadline. The first parallel run crossed the fixture's 50 ms deadline before
  the replacement callback completed and exercised a different Delete path.
- A delayed claim lookup joined the one startup published by a concurrent
  caller. Both requests received the same runtime from one launch.
- All 15 MCP tool definitions matched `0eb95b7` exactly. The per-request MCP
  version is `2026-07-28` and the owner read contract is `pi-bridge-read-v2`.
  A differential read check matched 480 pages containing escaped text,
  multibyte characters, lone surrogates, and mixed metadata under standalone
  and batch budgets.
- `git diff --check` and DocDoki validation passed.

## Publication

`auto-dev` uses the current `0.8.0-dev.N` series and local verification.
[CI](../../.github/workflows/ci.yml) runs for `main`. A main release uses the
plain version from `package.json` with a matching tag.
