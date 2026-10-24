# Magic Context reader

This is an optional external Bridge module. Bridge core does not import it.
It reads Magic Context **0.49.20, main SQLite schema 95** (MC reserves migration
numbers from 10000 for a separate fork lane). It requires Node's built-in
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
search, refs, expansion, budgets and frozen pagination. The reader selects stored items
using the request preset:

| Preset             | Recent session compartments | Highest-priority eligible project memories |
| ------------------ | --------------------------- | ------------------------------------------ |
| `latest` (default) | 2                           | 3                                          |
| `recent`           | 4                           | 5                                          |
| `full`             | All                         | All                                        |

Counts are upper limits; `detail` changes presentation, never this selection.
`latest` and `recent` exclude summaries whose native ending entry is confirmed
on another branch **before** applying the 2/4 limit. `full` and search retain
those historical summaries. Each summary carries `branch_relation`:
`on_branch`, `off_branch`, or `unknown`. This describes ancestry of its ending
entry, not whether its conclusions still apply. Compaction does not discard
ancestors for this check. Missing entries, unresolved MC boundaries and incomplete
ancestry stay unknown; unknown summaries remain eligible. Own-project memories
are not filtered by the session branch.

Bridge uses `full` for search, allowing older summaries and lower-priority
memories to be found without first expanding the read preset. `coverage` reports
`{ type, selected, total }` for `summary` and `memory` before Bridge's type filters
and page budget. Totals count only this session's compartments with content and
the own-project memories eligible below. MC's empty boundary markers do not
consume summary slots. Summary coverage adds `excluded` when default branch
filtering removes stored summaries. Use `recent` or `full`
to widen the selected set; pagination traverses only the acquired selection.

- Compartments contain their P1/full stored summary as `text`, P2 (or P3) as
  `preview`, title and a historical native leaf when the ending entry is real.
  MC folds tool results into subsequent user messages: its message/part boundaries
  are kept as `mc_*` provenance, never represented as an exact native range.
  Existing flat summaries in the
  current schema retain their stored `content`. These are summaries, not raw
  messages. Unresolved or synthetic ending coordinates do not produce a native leaf.
- Memories include only active/permanent, unexpired, non-superseded rows belonging
  to the verified **own project**. Items are stored in ascending importance and
  update time so Bridge's backwards pagination selects the most important/recent
  memories first. Workspace
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
Unsupported versions/missing columns report `MAGIC_CONTEXT_SCHEMA_MISMATCH`;
update the module together with the supported MC schema. Changed identity during
acquisition reports `MAGIC_CONTEXT_SESSION_MISMATCH`. Bridge wraps module failures
in its reader error without silently substituting another source.

## Validation

```sh
node --test integrations/magic-context/index.test.mjs
```

The isolated SQLite fixtures cover current schema checks, session/project/harness
matching, background registration without activation, memory visibility,
preset limits and coverage, brief/detail content, source limitations, Git
identity and absence of DB writes. Branch fixtures use native Pi projection to
check filtering before limits, compaction ancestry, unknown boundaries, retained
historical search/source refs, and reuse of one capture for native progress.
They do not read the user's actual memory database.

Source basis: [Magic Context 0.49.20](https://github.com/cortexkit/magic-context/tree/08d2615c2aff05fd62823c195ab0ffd479d7a8e5),
especially `packages/plugin/src/features/magic-context/compartment-storage.ts`,
`memory/project-identity.ts`, `memory/types.ts`, `storage-session-tables.ts`,
`migrations.ts`, and `packages/pi-plugin/src/index.ts`.
