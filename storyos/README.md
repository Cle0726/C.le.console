# C.le. StoryOS v0.3

StoryOS is a deterministic story-state and context foundation for long-form fiction projects.

The core contract is intentionally strict:

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story state is derived only from canonical story events.
4. Canon facts have explicit authority and timeline scope.
5. AI/import extraction writes Candidate Claims, never Canon directly.
6. Model context is compiled through deterministic gates; retrieval cannot bypass story rules.
7. SQLite indexes and workflow data are rebuildable runtime artifacts, never Canon.

## v0.3 scope

v0.3 keeps all v0.2 state/Canon/claim foundations and adds the first Story Context Compiler:

- explainable `story.context.v1` Context Manifest
- AUTHOR and POV context modes
- mandatory participant and POV identity/state context
- timeline-aware and authority-aware Canon selection
- `reveal_at` spoiler guard
- explicit POV knowledge guard based on `knowledge.gained/lost` events
- manual pins that remain subject to all gates
- dependency expansion from safe parents, with every dependency re-validated
- semantic retriever protocol where search results are candidates only
- deterministic output independent of retriever return order
- soft context budget for optional content; required identity/state context is retained
- explainable exclusions (`not_revealed`, `pov_unknown`, `canon_ambiguous`, `shadowed_by_authority`, `budget`, `unknown_ref`, etc.)
- `storyos context` CLI command

A real vector database is deliberately **not** part of v0.3. Vector search will be an adapter behind the `SemanticRetriever` boundary so it cannot become a source of truth or bypass the gating layer.

## Context modes

### POV mode

Use for prose generation from a specific character/story viewpoint. A Canon fact is eligible only when it is:

1. true at the requested story sequence;
2. the resolved highest-authority mainline fact;
3. already revealable at that sequence;
4. public, or explicitly known by the POV character.

A 0.99 semantic similarity score and a manual pin still cannot override these checks.

### AUTHOR mode

Use for planning, structural analysis, continuity editing and author-only reasoning. AUTHOR mode may include true-but-unrevealed Canon, but it still obeys story-time validity and Canon authority resolution.

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

# POV context before the fact is revealed/known: the locked fact is excluded.
storyos context examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --pov chr_00000000000000000000000000000001 \
  --mode pov

# Author planning context may see true-but-unrevealed Canon.
storyos context examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --mode author
```

The demo also deliberately contains a staged claim whose file says `status: approved` while conflicting with locked Canon. It must still have zero effect on projected Story State. This protects the invariant that AI output cannot promote itself into Canon.

Desktop UI, real embedding/vector adapters, model providers, Git-aware approval UX and prompt assembly remain later layers built on top of these contracts.
