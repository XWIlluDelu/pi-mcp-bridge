# Magic Context reader

This standalone, zero-dependency optional reader uses only Node.js built-ins
(including `node:sqlite`, with zero imports from Bridge internals) to read Magic
Context's stored summaries and memories. Configure its module (file or directory
path) and database explicitly:

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

For a positive summary count, filtering happens before taking the last N items.
Each summary carries `branch_relation`: `on_branch`, `off_branch`, or `unknown`.
This describes ancestry of its ending entry, not whether its conclusions still
apply. Compaction does not discard ancestors for this check. Missing entries,
unresolved MC boundaries and incomplete ancestry stay unknown; unknown summaries
remain eligible. Project memories are not filtered by the session branch.

`coverage` totals count this session's compartments with content and the
own-project memories eligible below. MC's empty boundary markers do not consume
summary slots. Summary coverage adds `excluded` when branch filtering removes
stored summaries. With `summary:0` the reader counts stored summaries and skips
the branch lookup.

- Summary text uses P1 or the flat stored content. Shorter tiers supply the
  preview in P2, P3, P4 order, and also supply the text when all fuller content
  is empty. A real ending entry can link to its historical native leaf. MC folds
  tool results into subsequent user messages, so its `mc_*` coordinates describe
  the store's boundaries. Unresolved or synthetic coordinates have no leaf link.
- Memories include only active/permanent, unexpired, non-superseded rows belonging
  to the verified **own project**. The reader selects by importance and update time, then preserves the selected
  store order through forward pagination. Workspace
  shares, notes, primers, docs, profiles and vectors are outside this reader's
  coverage. `source.scope` records `own_project`.
- Memory provenance identifies its origin session/type and verification state.
  It does not invent an exact source message from a session-level relationship.
- Returned data is the current **stored** extension snapshot, marked in `source`.
  It does not claim to be present in the most recently captured `runtime` context.
- Explicit historical `leaf_id` requests automatically fall back to Bridge's
  native Session Context view (`view:"session"`), so callers do not need to pass
  `view:"session"` manually when inspecting a historical leaf; this module never
  reads or forks raw history.

Each operation uses a read-only SQLite transaction. It closes the connection
before acquiring native history, and reads committed updates on the next call.

The reader expects text summaries/memories, numeric ordering, integer millisecond
timestamps and native boundary identifiers; it validates eligible own-project
memory expiry before filtering. Unknown rebase states remain readable without
claiming a native history leaf. A missing/unreadable database
(`MAGIC_CONTEXT_DATABASE_UNAVAILABLE`), missing columns or incompatible rows
(`MAGIC_CONTEXT_SCHEMA_MISMATCH`) and identity changes during acquisition
(`MAGIC_CONTEXT_SESSION_MISMATCH`) fail the read. Bridge reports reader failures
to clients as `SESSION_READER_FAILED` with the module code in `detail`, and never
substitutes another source on failure.

## Validation

```sh
node --test integrations/magic-context/index.test.mjs
```

The tests use isolated SQLite fixtures and native Pi projection; they do not read
the user's actual memory database.

Source basis: [Magic Context 0.49.20](https://github.com/cortexkit/magic-context/tree/08d2615c2aff05fd62823c195ab0ffd479d7a8e5),
especially `packages/plugin/src/features/magic-context/compartment-storage.ts`,
`memory/project-identity.ts`, `memory/types.ts`, `storage-session-tables.ts`,
`migrations.ts`, and `packages/pi-plugin/src/index.ts`.
