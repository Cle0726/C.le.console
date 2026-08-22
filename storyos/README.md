# C.le. StoryOS v0.4

StoryOS is a deterministic story-state, Canon and context foundation for long-form fiction projects.

The core contract is intentionally strict:

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story state is derived only from canonical story events.
4. Canon facts have explicit authority and timeline scope.
5. AI/import extraction writes Candidate Claims, never Canon directly.
6. Retrieval produces candidates only; it cannot bypass story/context rules.
7. Objective world state is not assumed to be POV-visible state.
8. SQLite indexes and workflow data are rebuildable runtime artifacts, never Canon.

## v0.4 scope

v0.4 keeps the v0.3 Context Compiler and adds the first real retrieval/debugging layer:

- deterministic `SQLiteCanonicalRetriever`
- retrieval corpus restricted to stable entities + mainline Canon facts
- Story Events and staged Candidate Claims are excluded from retrieval
- Unicode NFKC/case normalization and CJK-aware lexical query terms
- deterministic 0..1 scores with stable tie-breaking
- `ContextInspector` summary and per-ref trace
- raw retrieval audit (`ref`, score)
- `storyos retrieve` CLI command
- `storyos context --query` for real retrieval followed by all v0.3 gates
- `storyos context-inspect` for compact why-in / why-out diagnostics
- automatic rebuild of a missing/unsupported disposable `.storyos/index.sqlite` from canonical files
- `story.retrieval.v1` and `story.context-inspection.v1` output schemas

A future embedding/vector adapter will implement the same retriever boundary. It will not replace the deterministic Context Compiler or become a source of truth.

## Retrieval safety boundary

The v0.4 retriever reads only:

```text
entities
canon_facts (planning/current/draft/locked mainline authority)
```

It deliberately does **not** search:

```text
events
staged_claims
claim_fts
```

This means an AI-generated Candidate Claim cannot become model context merely because its text is semantically or lexically similar. Even retrieved Canon refs remain candidates until they pass:

```text
Timeline
  ↓
Canon Authority
  ↓
Reveal Guard
  ↓
POV Knowledge
  ↓
Entity / State Visibility
  ↓
POV-safe State Projection
  ↓
Budget
```

## Context modes

### POV mode

Use for prose generation from a specific character/story viewpoint. A Canon fact is eligible only when it is true at the requested sequence, resolves at the highest active mainline authority, is already revealable, and is public or explicitly known by the POV character.

Objective Story State is projected conservatively. The default POV-safe state key is:

```text
location
```

Additional state keys must be explicitly opted in. An unrelated future entity returned by retrieval remains excluded.

### AUTHOR mode

Use for planning, structural analysis and continuity editing. AUTHOR mode may include true-but-unrevealed Canon and complete objective state, while still obeying story-time validity and authority resolution.

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

Raw canonical retrieval:

```bash
storyos retrieve examples/demo "凯登"
storyos retrieve examples/demo "identity role" --limit 8
```

POV context with real retrieval. At sequence 150 the demo locked role fact may be retrieved but must still be excluded by the reveal guard:

```bash
storyos context examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --pov chr_00000000000000000000000000000001 \
  --mode pov \
  --query protagonist
```

Inspect exactly why that ref was blocked:

```bash
storyos context-inspect examples/demo \
  --through 150 \
  --participant chr_00000000000000000000000000000001 \
  --pov chr_00000000000000000000000000000001 \
  --mode pov \
  --query protagonist \
  --ref canon_00000000000000000000000000000001
```

The demo deliberately contains a staged claim whose file says `status: approved` and proposes `antagonist`. Running:

```bash
storyos retrieve examples/demo antagonist
```

must return no staged-claim hit. File status alone never promotes Candidate Claims into Canon or retrieval context.

Desktop UI, embedding/vector providers, LLM providers, Git-aware approval UX and prompt assembly remain later layers built on top of these contracts.
