# C.le. StoryOS v0.6

StoryOS is a deterministic story-state, Canon, context, migration and review-staging foundation for long-form fiction.

## Core contract

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story State is derived only from canonical Story Events.
4. Canon Facts have explicit authority and timeline scope.
5. AI/import/extraction may propose Candidate Claims, never Canon directly.
6. Retrieval produces candidates only and cannot bypass context guards.
7. Objective world state is not assumed to be POV-visible state.
8. SQLite/workflow indexes are disposable runtime data.
9. Mother-package migration must be lossless before it becomes interpretive.
10. Natural-language extraction must preserve evidence and unresolved ambiguity instead of guessing.

## v0.6: World State → Candidate Claims

After importing the v3.9 mother package with v0.5, analyze its preserved 118 World State scene records:

```bash
storyos worldstate-claims PROJECT
```

The default is **dry-run**. It prints a deterministic extraction report but writes no Candidate Claims.

Persist the same deterministic candidates only with an explicit action:

```bash
storyos worldstate-claims PROJECT --write
```

Generated claims live under:

```text
staging/
├── claims/
│   └── world_state/
└── extraction/
    └── world_state/
        └── report.json
```

They remain `status: pending`, `proposed_authority: draft`, and are never consumed by `StoryStateProjector` until a separate explicit approval/materialization step occurs.

### Conservative rules

v0.6 deliberately extracts only facts with simple deterministic evidence:

```text
present_raw + space_time
    → explicit named character
    → location.observed

NameEntry
    → story.entry_scene

item = character
    → possession.item.<stable-key>

one explicit character + condition wording
    → condition.note (raw source text preserved)

one explicit character + knowledge wording
    → knowledge.note (raw source text preserved)
```

Condition and knowledge rules intentionally store the original clause. v0.6 does not turn a phrase such as `凯登手指失灵残留` into a medical ontology, nor does it turn `凯登确认...` directly into `knowledge.gained` for a Canon Fact that has not yet been normalized.

### Ambiguity policy

The following are not guessed:

```text
三人
四人
主队
众人
同上
multi-character ambiguous clauses
unsupported natural-language state changes
```

They are preserved in `unresolved` with machine-readable reasons such as:

```text
group_reference_not_inferred
no_explicit_character_match
no_explicit_character_subject
multiple_character_mentions_ambiguous
no_conservative_rule
```

This makes extraction coverage measurable without pretending the parser understood more than it did.

### Story sequence policy

Imported scene observations receive a stable sequence anchor:

```text
season * 1,000,000
+ episode * 10,000
+ scene * 100
+ clause ordinal (0..99)
```

This leaves deterministic room for multiple approved events inside one scene later without renumbering the entire season.

### Real v3.9 baseline

A conservative offline pass over the supplied 118-scene v3.9 World State ledger produced approximately:

```text
262 Candidate Claims
├── 228 explicit-character location observations
├── 11 explicit Entry observations
├── 8 simple item=character possession observations
├── 3 explicit condition notes
└── 12 explicit knowledge notes
```

Large amounts of natural-language material remain unresolved by design, especially group references and clauses without a single explicit character subject. The goal of v0.6 is precision and traceability, not maximum automatic recall.

## v0.5: 《断弦之歌》v3.9 migration

Import the Season 1 v3.9 production mother package:

```bash
storyos import-duanxian-v39 /path/to/v3.9-mother-package /path/to/new-storyos-project
```

The importer verifies the package manifest by default. Known source changes require an explicit escape hatch:

```bash
storyos import-duanxian-v39 SOURCE TARGET --allow-dirty-source
```

Any mismatch remains visible in `imports/duanxian_v3_9/report.json`.

### Imported layout

```text
new-project/
├── storyos.yaml
├── manuscript/
│   └── S01/                         # 36 byte-preserved episode working copies
├── entities/
│   └── characters/                  # 50 deterministic character entities
├── sources/
│   ├── mother_package/              # complete byte-exact v3.9 snapshot
│   └── world_state/
│       ├── scenes/                   # 118 imported source records
│       └── editorial_inserts/        # 1 non-mutating insert record
└── imports/
    └── duanxian_v3_9/
        └── report.json
```

v0.5 itself creates 0 Story Events, 0 Canon Facts and 0 Candidate Claims from natural-language management prose. v0.6 is the separate review-staging layer.

## Deterministic context stack

```text
Canonical files
    ↓
Event-sourced Story State / Knowledge Timeline
    ↓
Canon Authority + Reveal rules
    ↓
Canonical Retriever (entities + mainline Canon only)
    ↓
Context Compiler
    ↓
POV / AUTHOR context manifests
    ↓
Context Inspector
```

Staged Candidate Claims are not part of canonical retrieval and do not affect projected Story State.

## Useful CLI commands

```bash
storyos import-duanxian-v39 SOURCE TARGET
storyos worldstate-claims PROJECT
storyos worldstate-claims PROJECT --write
storyos validate PROJECT
storyos claims PROJECT
storyos index PROJECT
storyos state PROJECT --through 1010100
storyos canon PROJECT SUBJECT PREDICATE --through 1010100
storyos knowledge PROJECT CHARACTER --through 1010100
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Next layer

The next stage should be a **Claim Review / Normalization Workbench**: group staged observations by character, scene and predicate; compare them with current Canon/State; normalize raw condition/knowledge notes; and require explicit author approval before creating Story Events or Canon Facts.

Desktop UI, LLM providers, vector/embedding adapters, Git-aware approval UX and final prompt assembly remain later layers built on top of these contracts.
