# C.le. StoryOS v0.8

StoryOS is a deterministic story-state, Canon, context, migration, extraction, review and quarantine-materialization foundation for long-form fiction.

## Core contract

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story State is derived only from canonical Story Events.
4. Canon Facts have explicit authority and timeline scope.
5. AI/import/extraction may propose Candidate Claims, never Canon directly.
6. Retrieval produces candidates only and cannot bypass context guards.
7. Objective world state is not assumed to be POV-visible state.
8. Mother-package migration is lossless before interpretation.
9. Natural-language extraction preserves evidence and unresolved ambiguity instead of guessing.
10. Review decisions are not Canon.
11. **Quarantine materialization candidates are also not Canon; a separate explicit commit gate is required.**

## v0.8: Reviewed Claim → quarantine materialization

v0.8 adds one more safety boundary between an accepted review and canonical `events/` / `canon/` files.

Inspect all reviewed claims without writing anything:

```bash
storyos materialization-plan PROJECT
storyos materialization-plan PROJECT --claim CLAIM_ID
```

A claim is `ready: true` only when all of these remain true at plan time:

```text
review exists
review decision is accept_event_candidate or accept_fact_candidate
review fingerprint still matches the current Candidate Claim
normalized target is present
current Canon/Story State check has no error
normalized target is not already canonical
```

The important point is that v0.8 does **not** trust an old review-time result. The normalized target is reconstructed as a temporary Candidate Claim and checked again against the current project.

For example:

```text
T1  author accepts a staged claim
T2  new locked Canon is added later
T3  materialization-plan runs
    → current_conflict
    → blocked
```

### Quarantine staging

Stage one ready candidate explicitly:

```bash
storyos materialization-stage PROJECT CLAIM_ID
```

This writes only to quarantine:

```text
staging/
└── materialization/
    ├── events/
    │   └── evt_<stable-id>.yaml
    └── facts/
        └── canon_<stable-id>.yaml
```

It does **not** write:

```text
events/
canon/
```

Each quarantine candidate records:

```text
source Claim id + fingerprint
review decision and normalized target
latest Canon/State check
stable target id
complete proposed canonical payload
explicit assumptions
quarantine-only policy
```

The materialization plan exposes the proposed payload under:

```text
item.candidate.canonical_payload
```

### Event candidates

`accept_event_candidate` produces a deterministic StoryEvent candidate using existing StoryOS state-setting semantics:

```text
normalized predicate: injury.left_hand
normalized value: numb

→ type: injury.left_hand.set
→ payload.value: numb
```

The original Claim story position is reused for the candidate, but the file remains quarantined until a later commit gate accepts it.

### Fact candidates

`accept_fact_candidate` produces a deterministic CanonFact candidate. v0.8 inherits the Candidate Claim's proposed authority and currently proposes:

```text
valid_from = original Claim sequence
```

That is explicitly recorded as an **assumption requiring commit-time review**, not as an already-approved timeline rule.

### Blocking reasons

Typical reasons include:

```text
unreviewed
decision_reject
decision_defer
stale_review
missing_normalized_target
current_conflict
already_canonical_duplicate
```

A blocked claim cannot be staged.

Repeated staging of an identical quarantine candidate is idempotent and returns `unchanged`. A different file already occupying the same deterministic target id is rejected instead of overwritten.

### Canon safety invariant

v0.8 deliberately keeps these operations separate:

```text
review
  ≠ materialization staging
  ≠ canonical commit
```

Both `materialization-plan` and `materialization-stage` leave canonical Story Events and Canon Facts unchanged.

## v0.7: Claim Review / Normalization Workbench

Inspect staged Candidate Claims:

```bash
storyos claim-review PROJECT
storyos claim-review PROJECT --subject CHAR_ID
storyos claim-review PROJECT --predicate condition.
storyos claim-review PROJECT --claim CLAIM_ID
```

A reviewer records one of:

```text
accept_event_candidate
accept_fact_candidate
reject
defer
```

Accept decisions require an explicit normalized target:

```bash
storyos claim-decide PROJECT CLAIM_ID \
  --decision accept_event_candidate \
  --predicate injury.left_hand \
  --value-json '"numb"'
```

Review sidecars live under `staging/reviews/` and fingerprint the underlying Claim. If the Claim changes later, the review becomes stale. Different decisions require explicit `--replace`; identical decisions are idempotent.

Review changes neither Claim status nor canonical data.

## v0.6: World State → Candidate Claims

Analyze the 118 imported World State scene records:

```bash
storyos worldstate-claims PROJECT
```

Dry-run is the default. Persist deterministic candidates only with:

```bash
storyos worldstate-claims PROJECT --write
```

v0.6 extracts conservative observations only: explicit named-character scene presence/location, direct `NameEntry`, simple `item=character` possession, and raw single-character condition/knowledge notes. Ambiguous group references remain unresolved rather than being guessed.

A conservative pass over the supplied v3.9 ledger produced approximately:

```text
262 Candidate Claims
├── 228 explicit-character location observations
├── 11 direct Entry observations
├── 8 simple possession observations
├── 3 explicit condition notes
└── 12 explicit knowledge notes
```

## v0.5: 《断弦之歌》v3.9 migration

Import the production mother package:

```bash
storyos import-duanxian-v39 SOURCE TARGET
```

The importer verifies the v3.9 manifest, snapshots the complete mother package byte-for-byte, creates 36 manuscript working copies, 50 deterministic character entities, 118 imported World State source records and one editorial-insert source record.

It does not auto-create Story Events, Canon Facts or Candidate Claims from natural-language management prose.

## Deterministic context stack

```text
Canonical files
    ↓
Event-sourced Story State / Knowledge Timeline
    ↓
Canon Authority + Reveal rules
    ↓
Canonical Retriever
    ↓
Context Compiler
    ↓
POV / AUTHOR Context Manifest
    ↓
Context Inspector
```

Staged Claims, review sidecars and materialization quarantine files stay outside canonical retrieval and do not affect projected Story State.

## Current authoring pipeline

```text
v3.9 Mother Package
        ↓ lossless import
Imported Sources
        ↓ conservative extraction
Candidate Claims
        ↓ author review + normalization
Review Sidecars
        ↓ current revalidation
Quarantine Materialization Candidates
        ↓ future explicit Canon Commit Gate
StoryEvent / CanonFact
        ↓
Story State / Knowledge / Context Compiler
        ↓
Long-form continuation
```

## Useful CLI commands

```bash
storyos import-duanxian-v39 SOURCE TARGET
storyos worldstate-claims PROJECT
storyos worldstate-claims PROJECT --write
storyos claim-review PROJECT
storyos claim-decide PROJECT CLAIM_ID --decision defer --note "..."
storyos materialization-plan PROJECT
storyos materialization-plan PROJECT --claim CLAIM_ID
storyos materialization-stage PROJECT CLAIM_ID
storyos validate PROJECT
storyos claims PROJECT
storyos index PROJECT
storyos state PROJECT --through 1010100
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Verification

The functional v0.8 head before this documentation update passed **61 StoryOS tests** on Ubuntu and Windows with Python 3.11 and 3.13. The final documentation head is still validated by the same CI workflows before v0.8 is frozen.

## Next layer

v0.9 should be an **Explicit Canon Commit Gate**. It should consume only quarantine candidates, revalidate their fingerprints and current world conflicts again, compare the exact canonical payload about to be written, require an explicit commit action, and produce an audit record for every canonical mutation.

Desktop UI, LLM providers, vector/embedding adapters and Git-aware authoring UX remain later layers built on top of these contracts.
