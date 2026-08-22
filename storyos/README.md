# C.le. StoryOS v0.9

StoryOS is a deterministic story-state, Canon, context, migration, extraction, review, quarantine-materialization and explicit Canon-commit foundation for long-form fiction.

## Core contract

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story State is derived only from canonical Story Events.
4. Canon Facts have explicit authority and timeline scope.
5. AI/import/extraction may propose Candidate Claims, never Canon directly.
6. Review decisions are not Canon.
7. Quarantine materialization candidates are not Canon.
8. Retrieval cannot bypass timeline, authority, reveal, POV or knowledge guards.
9. Natural-language extraction preserves evidence and unresolved ambiguity instead of guessing.
10. Canon mutation is create-only, explicit, hash-confirmed and audit-authorized.
11. **Every Canon create must be revalidated against the current world immediately before the write.**

## v0.9: Explicit Canon Commit Gate

v0.9 is the first StoryOS layer allowed to create canonical `StoryEvent` or `CanonFact` files.

It consumes only an already reviewed and already staged quarantine candidate.

Inspect the current commit plan first:

```bash
storyos canon-commit-plan PROJECT
storyos canon-commit-plan PROJECT --claim CLAIM_ID
```

A ready item exposes the exact quarantine file and confirmation hash:

```text
candidate_path
candidate_sha256
canonical_path
canonical_payload
canonical_payload_sha256
audit_id
audit_path
```

The author then commits explicitly:

```bash
storyos canon-commit PROJECT CLAIM_ID \
  --confirm-sha256 <candidate_sha256-from-plan> \
  --actor "author" \
  --note "approved exact reviewed candidate"
```

There is deliberately no shortcut that automatically reads the hash and commits in one step. The confirmation is a boundary between inspecting the exact quarantine candidate and authorizing a canonical mutation.

### Commit sequence

A fresh canonical create follows this order:

```text
1. rebuild current materialization plan
2. require current item to be ready
3. validate quarantine schema / IDs / policies
4. require quarantine file to equal current expected candidate
5. require caller confirmation of exact quarantine SHA-256
6. derive deterministic audit identity and canonical target
7. create immutable authorization audit
8. rebuild the entire current plan again
9. verify quarantine SHA still matches
10. verify current Canon / Story State still permits the candidate
11. create canonical file using create-only filesystem semantics
12. reload and verify exact written payload
```

The audit is intentionally written before Canon.

If the process fails after authorization but before the canonical create, StoryOS may retain an **unused authorization audit**, but Canon remains unchanged. A later retry may continue only if the exact quarantine candidate and all current world checks are still valid.

### Canon paths

Canonical creates are isolated under deterministic paths:

```text
events/
└── committed/
    └── evt_<stable-id>.yaml

canon/
└── committed/
    └── canon_<stable-id>.yaml
```

Authorization audits are stored separately:

```text
audit/
└── canon_commits/
    └── aud_<stable-id>.yaml
```

The audit records:

```text
action = authorize_canonical_create
actor
note
Claim id + Claim fingerprint
candidate path + candidate SHA-256
canonical path
canonical payload + canonical payload SHA-256
checks performed
create-only / immutable policy
```

### Create-only invariant

v0.9 never overwrites an existing canonical file.

If the deterministic target already exists:

```text
same payload + exact matching immutable audit
    → previously committed / idempotent unchanged

same payload but no matching audit
    → canonical_target_untracked / blocked

different payload
    → canonical_target_conflict / blocked

same target ID elsewhere in canonical storage
    → canonical_id_exists_elsewhere / blocked
```

StoryOS does not silently adopt or repair manually created canonical files.

### One committed target per Claim

After a Claim has produced an audited canonical target, changing its review to point to a different Event/Fact does not permit a second commit:

```text
Claim A
  → audited Event X

later review changed
  → Event Y
  → claim_already_committed
  → blocked
```

Corrections should use a future explicit amendment/retraction workflow rather than rewriting the historical approval chain.

### Revalidation after authorization

The authorization audit is not a permanent bypass token.

For example:

```text
T1 quarantine candidate is safe
T2 author confirms hash
T3 authorization audit is written
T4 a new locked Canon appears
T5 commit gate rebuilds current plan
T6 current_conflict
T7 canonical file is NOT created
```

The unused audit remains as evidence that an authorization was attempted for that exact candidate, but it does not force Canon through a now-invalid world state.

## v0.8: Reviewed Claim → quarantine materialization

Before v0.9, v0.8 rechecks reviewed Claims and stages exact candidate envelopes without touching Canon:

```bash
storyos materialization-plan PROJECT --claim CLAIM_ID
storyos materialization-stage PROJECT CLAIM_ID
```

Quarantine files live under:

```text
staging/materialization/events/
staging/materialization/facts/
```

They preserve the Claim fingerprint, review decision, current conflict check, proposed canonical payload and assumptions. Stale reviews, current conflicts and already-canonical duplicates are blocked.

## v0.7: Claim Review / Normalization

```bash
storyos claim-review PROJECT
storyos claim-decide PROJECT CLAIM_ID \
  --decision accept_event_candidate \
  --predicate injury.left_hand \
  --value-json '"numb"'
```

Review decisions live under `staging/reviews/`, require explicit normalization for accept decisions, fingerprint the underlying Claim, and remain non-canonical.

## v0.6: World State → Candidate Claims

```bash
storyos worldstate-claims PROJECT
storyos worldstate-claims PROJECT --write
```

The extractor deliberately favors precision over recall. A conservative pass over the supplied 《断弦之歌》 v3.9 118-scene World State ledger produced approximately:

```text
262 Candidate Claims
├── 228 explicit-character location observations
├── 11 direct Entry observations
├── 8 simple possession observations
├── 3 explicit condition notes
└── 12 explicit knowledge notes
```

Ambiguous groups, unsupported semantics and unclear subjects remain unresolved rather than guessed.

## v0.5: 《断弦之歌》v3.9 migration

```bash
storyos import-duanxian-v39 SOURCE TARGET
```

The importer verifies the v3.9 manifest, snapshots the source package byte-for-byte, creates 36 manuscript working copies, 50 deterministic character entities, 118 World State source records and one editorial-insert source record. Natural-language management prose is not automatically promoted to Canon.

## Current authoring pipeline

```text
v3.9 Mother Package
        ↓ lossless import
Imported Sources
        ↓ conservative extraction
Candidate Claims
        ↓ explicit review + normalization
Review Sidecars
        ↓ current revalidation
Quarantine Materialization Candidates
        ↓ hash-confirmed + audit-authorized commit
StoryEvent / CanonFact
        ↓
Story State / Knowledge Timeline
        ↓
Canon Authority / Reveal / POV gates
        ↓
Canonical Retriever + Context Compiler
        ↓
Long-form continuation
```

## Useful CLI commands

```bash
storyos import-duanxian-v39 SOURCE TARGET
storyos worldstate-claims PROJECT --write
storyos claim-review PROJECT
storyos claim-decide PROJECT CLAIM_ID --decision defer --note "..."
storyos materialization-plan PROJECT --claim CLAIM_ID
storyos materialization-stage PROJECT CLAIM_ID
storyos canon-commit-plan PROJECT --claim CLAIM_ID
storyos canon-commit PROJECT CLAIM_ID --confirm-sha256 HASH --actor AUTHOR --note "..."
storyos validate PROJECT
storyos state PROJECT --through 1010100
storyos canon PROJECT SUBJECT PREDICATE --through 1010100
storyos knowledge PROJECT CHARACTER --through 1010100
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Verification

The functional v0.9 head before this documentation update passed **74 StoryOS tests** on Ubuntu and Windows with Python 3.11 and 3.13 test steps. The final documentation head is validated again before v0.9 is frozen.

The v0.9 tests include failure injection around the commit boundary, including canonical-write failure after audit creation and a new Canon conflict injected immediately after authorization.

## Next layer

After v0.9 is frozen, the data-safety pipeline is strong enough to stop adding more write gates. The next useful layer should be a read-oriented **Authoring Workspace API** that composes manuscript, current Story State, approved Canon, unresolved/review queues and context inspection into stable UI-facing views. Desktop UI should consume those APIs rather than reading StoryOS files directly.
