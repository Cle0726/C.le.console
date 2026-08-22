# C.le. StoryOS v0.2

StoryOS is the deterministic story-state foundation for long-form fiction projects.

The core contract is intentionally strict:

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story state is derived only from canonical story events.
4. Canon facts have explicit authority and timeline scope.
5. AI/import extraction writes Candidate Claims, never Canon directly.
6. SQLite indexes and workflow data are rebuildable runtime artifacts, never Canon.

## v0.2 scope

- Project manifest and folder protocol
- Stable typed identifiers
- Event schema and point-in-time state projection
- Canon Authority levels: locked, current, draft, planning, alternative, deprecated
- Deterministic Canon resolution by subject, predicate, timeline and authority
- Knowledge timeline queries bounded by story sequence
- Non-canonical `staging/claims/` channel
- Deterministic claim conflict checks against Canon and projected Story State
- Explicit claim-to-event materialization step that never writes Canon automatically
- Rebuildable SQLite/FTS index for entities, events, Canon facts and staged claims
- CLI commands for validation, indexing, state, Canon resolution, knowledge and claim checks
- JSON Schemas for project/entity/event/canon/claim v1

## Project channels

```text
story-project/
├── storyos.yaml
├── entities/          # stable story entities
├── events/            # canonical timeline changes
├── canon/             # stable facts/rules with authority
├── staging/
│   └── claims/        # AI/import proposals; never projected into story state
└── .storyos/          # disposable index/runtime data
```

## CLI examples

```bash
storyos validate examples/demo
storyos index examples/demo
storyos state examples/demo --through 150
storyos canon examples/demo chr_00000000000000000000000000000001 identity.role --through 150
storyos knowledge examples/demo chr_00000000000000000000000000000001 --through 199
storyos claims examples/demo
```

The demo deliberately contains a staged claim whose file says `status: approved` while conflicting with locked Canon. It must still have zero effect on projected Story State. This protects the invariant that AI output cannot promote itself into Canon.

Desktop UI, model providers, embeddings, Context Compiler and Git-aware author approval UX remain later layers built on top of these contracts.
