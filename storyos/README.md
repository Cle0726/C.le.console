# C.le. StoryOS v0.5

StoryOS is a deterministic story-state, Canon, context and migration foundation for long-form fiction.

## Core contract

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story State is derived only from canonical Story Events.
4. Canon Facts have explicit authority and timeline scope.
5. AI/import extraction may propose Candidate Claims, never Canon directly.
6. Retrieval produces candidates only and cannot bypass context guards.
7. Objective world state is not assumed to be POV-visible state.
8. SQLite/workflow indexes are disposable runtime data.
9. Mother-package migration must be lossless before it becomes interpretive.

## v0.5: 《断弦之歌》v3.9 migration

v0.5 adds a deterministic importer for the Season 1 v3.9 production mother package:

```bash
storyos import-duanxian-v39 /path/to/v3.9-mother-package /path/to/new-storyos-project
```

Default behavior is strict. The importer verifies the package manifest before writing a new project. Known source changes can be imported only with an explicit escape hatch:

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

The importer refuses a non-empty target directory so existing author work cannot be overwritten accidentally.

### Deliberate Canon boundary

v0.5 creates:

```text
50 Character entities
0 Story Events from state_diff prose
0 Canon Facts from Canon/outline prose
0 Candidate Claims from state_diff prose
```

`World_State_Ledger_36集.json` contains highly useful management text, but fields such as `state_diff` and `exit_snapshot` are still natural-language assertions. They are preserved under `sources/world_state/` rather than silently converted into deterministic state.

Likewise, the Canon/outline documents remain available in the byte-exact source snapshot but are not automatically promoted into `CanonFact` records. A later extraction layer must stage proposed facts/changes for review.

### Deterministic imported IDs

`stable_id(kind, namespace, key)` uses UUID5 behind a fixed StoryOS namespace. The same source identity always receives the same StoryOS ID across machines and repeat imports.

For the v3.9 role table the importer prefers stable asset identities such as `H01` / `T01`; source scene IDs such as `EP01-S01` drive deterministic scene-source IDs. This avoids tying identity to display names or output paths.

## Existing deterministic context stack

v0.5 retains the prior StoryOS layers:

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

Retrieval never searches staged Candidate Claims or Story Events as free-text candidate material. A retrieved ref must still pass Timeline, Authority, Reveal, POV Knowledge, entity visibility, POV-safe state projection and budget rules.

## Useful CLI commands

```bash
storyos validate PROJECT
storyos index PROJECT
storyos state PROJECT --through 150
storyos canon PROJECT SUBJECT PREDICATE --through 150
storyos knowledge PROJECT CHARACTER --through 150
storyos claims PROJECT
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 150 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 150 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Next layer

The next migration stage should not alter the importer. It should read the preserved 118 World State source records and produce reviewable Candidate Claims with source evidence. Only explicit author approval may materialize those claims into Story Events or Canon Facts.

Desktop UI, LLM providers, vector/embedding adapters, Git-aware approval UX and prompt assembly remain later layers built on top of these contracts.
