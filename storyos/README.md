# C.le. StoryOS v0.7

StoryOS is a deterministic story-state, Canon, context, migration, extraction and review foundation for long-form fiction.

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
10. **Review decisions are still not Canon; materialization is a separate gate.**

## v0.7: Claim Review / Normalization Workbench

After v0.6 has staged Candidate Claims, inspect them without modifying Canon:

```bash
storyos claim-review PROJECT
storyos claim-review PROJECT --subject CHAR_ID
storyos claim-review PROJECT --predicate condition.
storyos claim-review PROJECT --claim CLAIM_ID
```

Each queue item includes:

```text
original Candidate Claim + evidence
subject display name
current Canon / projected-State conflict check
prior review decision, if any
review fingerprint freshness / stale status
```

The queue is deterministic and read-only.

### Review decisions

A reviewer may record one of four decisions:

```text
accept_event_candidate
accept_fact_candidate
reject
defer
```

An accept decision requires an explicit normalized target. For example:

```bash
storyos claim-decide PROJECT CLAIM_ID \
  --decision accept_event_candidate \
  --predicate injury.left_hand \
  --value-json '"numb"' \
  --note "normalized from the source condition note"
```

A fact candidate uses the same explicit normalization boundary:

```bash
storyos claim-decide PROJECT CLAIM_ID \
  --decision accept_fact_candidate \
  --predicate identity.role \
  --value-json '"protagonist"'
```

Reject/defer decisions do not accept normalized target data:

```bash
storyos claim-decide PROJECT CLAIM_ID --decision reject --note "conflicts with locked Canon"
storyos claim-decide PROJECT CLAIM_ID --decision defer --note "needs author check"
```

Review sidecars are stored under:

```text
staging/reviews/<claim_id>.yaml
```

They contain a SHA-256 fingerprint of the reviewed Claim. If the underlying Claim later changes, `claim-review` marks the old review as `review_stale: true`; a later materializer must reject stale decisions.

A different existing decision is never silently replaced. Replacement must be explicit:

```bash
storyos claim-decide PROJECT CLAIM_ID --decision reject --replace
```

Repeating an identical decision is idempotent and returns `unchanged`.

### Review is not materialization

Even these decisions:

```text
accept_event_candidate
accept_fact_candidate
```

only mean “reviewed and normalized for a future materializer”. v0.7 does **not**:

```text
change Candidate Claim status
write events/
write canon/
change projected Story State
change character Knowledge Timeline
```

The next materialization layer must independently verify the Claim fingerprint again, rerun current Canon/State conflict checks, and require a separate explicit action.

## v0.6: World State → Candidate Claims

Analyze the 118 imported World State scene records:

```bash
storyos worldstate-claims PROJECT
```

This is dry-run by default. Persist deterministic candidates only with:

```bash
storyos worldstate-claims PROJECT --write
```

v0.6 extracts only conservative observations such as explicit named-character scene presence/location, direct `NameEntry`, simple `item=character` possession, and raw single-character condition/knowledge notes. Ambiguous group references (`三人`, `主队`, `众人`, `同上`, etc.) remain unresolved rather than being guessed.

A conservative pass over the supplied v3.9 ledger produced approximately:

```text
262 Candidate Claims
├── 228 explicit-character location observations
├── 11 direct Entry observations
├── 8 simple possession observations
├── 3 explicit condition notes
└── 12 explicit knowledge notes
```

The source evidence and unresolved clauses remain available for later review.

## v0.5: 《断弦之歌》v3.9 migration

Import the production mother package into a new StoryOS project:

```bash
storyos import-duanxian-v39 SOURCE TARGET
```

The importer verifies the v3.9 manifest, snapshots the complete mother package byte-for-byte, creates 36 manuscript working copies, 50 deterministic character entities, 118 imported World State source records and one editorial-insert source record. It does not auto-create Story Events, Canon Facts or Candidate Claims from management prose.

Known source modifications require an explicit escape hatch and remain recorded:

```bash
storyos import-duanxian-v39 SOURCE TARGET --allow-dirty-source
```

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

Staged Claims and review sidecars are outside canonical retrieval and do not affect projected Story State.

## Current authoring pipeline

```text
v3.9 Mother Package
        ↓ lossless import
Imported Sources
        ↓ conservative extraction
Candidate Claims
        ↓ author review + normalization
Review Sidecars
        ↓ future explicit materialization gate
StoryEvent / CanonFact
        ↓
Story State / Knowledge / Context Compiler
```

## Useful CLI commands

```bash
storyos import-duanxian-v39 SOURCE TARGET
storyos worldstate-claims PROJECT
storyos worldstate-claims PROJECT --write
storyos claim-review PROJECT
storyos claim-review PROJECT --subject CHAR_ID --predicate condition.
storyos claim-decide PROJECT CLAIM_ID --decision defer --note "..."
storyos validate PROJECT
storyos claims PROJECT
storyos index PROJECT
storyos state PROJECT --through 1010100
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Next layer

v0.8 should be a separate **Reviewed-Claim Materialization Staging** layer. It should reject stale reviews, rerun authority/state conflicts, produce deterministic Event/Fact candidates in quarantine, and still require an explicit final commit into canonical `events/` or `canon/` files.

Desktop UI, LLM providers, vector/embedding adapters and Git-aware approval UX remain later layers built on top of these contracts.
