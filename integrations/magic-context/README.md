# Magic Context reader

This is an optional external Bridge module. Bridge core does not import it.
Its consumed storage contract is based on Magic Context **0.49.20**. Compatibility
is checked against the queried tables/columns and interpreted row values, not
MC's global migration number. Unrelated additive migrations do not require a
reader update. It requires Node's built-in
`node:sqlite` and the current Bridge item-reader contract.

Enable it explicitly in owner configuration:

```json
{
  "compatibilityModules": [
    {
      "module": "/absolute/path/to/pi-mcp-bridge/integrations/magic-context/index.mjs",
      "options": {
        "database": "/absolute/path/to/magic-context/context.db"
      }
    }
  ]
}
```

There is no global database discovery. A configured database alone does not
activate the reader for a session. The target's native session ID must match a
`session_projects` record with `harness='pi'`, and its project identity must agree
with the target's authorized cwd. The module computes the current MC identity:
`git:<lexicographically first root commit>` or `dir:<12-character MD5 of the
absolute cwd>` for directories without Git history. Git failures other than a
confirmed unborn HEAD fail clearly; no stored identity is guessed.

`session_projects` is also populated by MC's background scan of all Pi sessions,
so matching additionally requires target-specific evidence: both live `ctx-status`
and `ctx-recomp` registrations, a target compartment, or an initialized target
`session_meta` record with transform activity/cached baseline. Other harnesses
and installation elsewhere do not qualify.

## Content and boundaries

The reader returns `{ native: true, items, coverage }`. It uses Bridge's authorized
native capture for source branch facts and current task/progress. Bridge handles
search, refs, expansion, budgets and frozen pagination. Background selection is
independent of `range`, which controls only the appended native input turns:

| Content control   | Default | Selection                                                                            |
| ----------------- | ------- | ------------------------------------------------------------------------------------ |
| `content.summary` | `2`     | Last N stored session compartments after excluding confirmed other-branch summaries. |
| `content.memory`  | `3`     | Highest-priority N eligible own-project memories.                                    |

`0` omits that kind. `summary:-1` includes all stored session summaries, including
other-branch history; `memory:-1` includes all eligible own-project memories.
Search acquires all supported items of its requested kinds, independently of
browse defaults. Changing the page budget does not widen selection.

For a positive summary count, filtering happens before taking the last N items.
Each summary carries `branch_relation`: `on_branch`, `off_branch`, or `unknown`.
This describes ancestry of its ending entry, not whether its conclusions still
apply. Compaction does not discard ancestors for this check. Missing entries,
unresolved MC boundaries and incomplete ancestry stay unknown; unknown summaries
remain eligible. Project memories are not filtered by the session branch.

`coverage` reports `{type,selected,total}` for summaries and memories before
search-result filtering and pagination. Totals count this session's compartments
with content and the own-project memories eligible below. MC's empty boundary
markers do not consume summary slots. Summary coverage adds `excluded` when
branch filtering removes stored summaries. Use a larger content count or `-1`
for a fresh broader capture; cursor pages traverse only the acquired items.

- Compartments contain their P1/full stored summary as `text`, P2 (or P3) as
  `preview`, title and a historical native leaf when the ending entry is real.
  MC folds tool results into subsequent user messages: its message/part boundaries
  are kept as `mc_*` provenance, never represented as an exact native range.
  Existing flat summaries in the
  current schema retain their stored `content`. These are summaries, not raw
  messages. Unresolved or synthetic ending coordinates do not produce a native leaf.
- Memories include only active/permanent, unexpired, non-superseded rows belonging
  to the verified **own project**. The reader selects by importance and update time, then preserves the selected
  store order through forward pagination. Workspace
  shares, notes, primers, docs, profiles and vectors are outside this first reader's
  coverage. `source.scope` records `own_project`.
- Memory provenance identifies its origin session/type and verification state.
  It does not invent an exact source message from a session-level relationship.
- Returned data is the current **stored** extension snapshot, marked in `source`.
  It does not claim to be present in the most recently captured `runtime` context.
- Explicit historical `leaf_id` requests reject. Use Bridge's Session Context view
  for a particular historical branch; this module never reads or forks raw history.

Every operation opens `DatabaseSync` with `readOnly:true`, enables `query_only`,
and uses a read transaction. No plugin entry point, getters, migrations,
telemetry, embedding, project registration or generation is invoked. It closes
the connection after each operation, leaving live Magic Context writers alone.

Missing/unreadable databases report `MAGIC_CONTEXT_DATABASE_UNAVAILABLE`.
Missing consumed columns or incompatible row representations report
`MAGIC_CONTEXT_SCHEMA_MISMATCH`. The reader expects text summaries/memories,
numeric ordering, integer millisecond timestamps and native boundary identifiers;
it validates eligible own-project memory expiry before filtering. Unknown rebase
states remain readable without claiming a native history leaf. Update the module
when those consumed storage semantics change; migration numbers are not proof
of either compatibility or incompatibility. Changed identity during
acquisition reports `MAGIC_CONTEXT_SESSION_MISMATCH`. Bridge wraps module failures
in its reader error without silently substituting another source.

## Validation

```sh
node --test integrations/magic-context/index.test.mjs
```

The isolated SQLite fixtures cover current schema checks, session/project/harness
matching, background registration without activation, memory visibility,
content limits and coverage, previews and reference content, source limitations, Git
identity and absence of DB writes. Branch fixtures use native Pi projection to
check filtering before limits, compaction ancestry, unknown boundaries, retained
historical search/source refs, and reuse of one capture for native progress.
They do not read the user's actual memory database.

Source basis: [Magic Context 0.49.20](https://github.com/cortexkit/magic-context/tree/08d2615c2aff05fd62823c195ab0ffd479d7a8e5),
especially `packages/plugin/src/features/magic-context/compartment-storage.ts`,
`memory/project-identity.ts`, `memory/types.ts`, `storage-session-tables.ts`,
`migrations.ts`, and `packages/pi-plugin/src/index.ts`.
