# Controlled long-session reading study

This reproducible offline exercise compares context, overview and focused reads
in a constructed session with long tool output. It measures content access and
coverage rather than real-model quality.

## Reproduce

Run with installed dependencies and a fresh output directory:

```sh
mkdir -p .local/research
node research/long-session-reading.mjs .local/research/long-session-run \
  > .local/research/long-session-reading.json
```

Choose a fresh directory for each run; keep generated sessions and raw reports private.

The harness uses public Pi 1.1.0 SDK APIs and an offline faux provider to generate
native JSONL, compaction, summarized tree navigation, tool execution, custom
messages and an explicit context edit. Every measured read goes through the
standard MCP stdio client.

## Fixture results

One run contained 15 prompts, 20 faux provider calls, five built-in tool
executions, one compaction and one summarized tree navigation. The resulting
session had 50 entries. Complete context required four pages; overview required
one. These counts describe this fixture and its default page budget.

- The latest correction changes the goal to local CSV parsing with empty
  identifiers rejected and Unicode coverage still pending. The first default
  context page misses it behind a long tool log; the first overview page includes
  it.
- An actual tool check fails with `EMPTY_IDENTIFIER_ACCEPTED`; a write changes
  `trim()` to `trim() || null`, and the next check reports
  `EMPTY_IDENTIFIER_REJECTED`. Overview includes the failure, repair and success.
  Focused context reads using the returned result-source entry IDs recover both
  checks independently.
- Display-hidden messages remain in the context projection; context-hidden and
  raw-only records do not. An abandoned leaf contains a migration proposal, but
  current context excludes it.
- Overview marks the omitted branch summary. A summary read recovers that summary
  and the active compaction checkpoint without reintroducing hidden history.
- A long assistant conclusion needs source expansion; a large log needs three
  fragment pages. Expanding every selected record blindly can cost more than
  sequential context reading. In this fixture, overview locates the recent
  correction and tool evidence efficiently; context reads retain the selected
  projection's chronological order.

All reads left session bytes and provider-call count unchanged. The fixture
verifies bounded reading and recovery of its selected evidence. Turn organization and continuation during activity require separate evaluation.
