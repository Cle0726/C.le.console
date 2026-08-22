# StoryOS v0.3 Architecture

## Source of truth

Canonical story data lives in human-readable project files. Runtime databases, retrieval indexes and workflow caches are disposable and rebuildable.

## Core invariants

1. Display names and file paths are never identifiers.
2. Story state is derived only from ordered canonical Story Events.
3. Point-in-time reads accept an explicit sequence boundary.
4. Unknown event types do not mutate projected state until a projector rule exists.
5. Canon Facts and Story Events are different domains: facts express authoritative assertions; events express changes over story time.
6. Candidate Claims are non-canonical proposals even if their source file contains `status: approved`.
7. Only an explicit approval action may materialize a Candidate Claim into a canonical Event/Fact.
8. Semantic retrieval creates context candidates only; it cannot bypass deterministic gates.
9. SQLite stores indexes and runtime state only.

## Event ordering

Events are replayed by `(at.sequence, id)`. The event ID is the deterministic tie-breaker when two events share a sequence.

## Canon authority

Mainline resolution uses the highest active authority at the requested story sequence:

```text
locked      400  author-locked fact; strongest
current     300  accepted current Canon
draft       200  current draft assertion
planning    100  planning-level assertion
alternative  50  alternate branch; excluded from mainline resolution
deprecated    0  retired assertion; excluded from mainline resolution
```

If two active facts at the same highest authority disagree, resolution is **ambiguous**. StoryOS must report the conflict instead of choosing arbitrarily.

`valid_from` / `valid_to` describe when a fact is true in story time. `reveal_at` is different: it describes when that fact may be revealed to the audience/context pipeline. A fact can therefore be true before it is revealable. When a restricted fact has `reveal_at` but no sequence boundary is supplied, the safe default is hidden.

## Knowledge timeline

Character knowledge is not inferred from Canon existence. It is derived from explicit canonical events:

```text
knowledge.gained { fact_id: canon_... }
knowledge.lost   { fact_id: canon_... }
```

This lets the system answer `what did this character know at sequence N?` without exposing future information.

## Candidate Claim staging

AI/import extraction writes into:

```text
staging/claims/
```

A staged claim may be checked against:

- resolved Canon at the claim's timeline position;
- projected Story State at that position;
- duplicate facts.

Claim files are never consumed by `StoryStateProjector`. Explicit approval creates a new Event/Fact candidate; persistence into canonical directories is a separate author-controlled operation.

## Story Context Compiler

The Context Compiler is not a generic RAG wrapper. Its job is to decide **which facts are legally visible to a model at a specific story point** and to explain every inclusion/exclusion.

The intended order is:

```text
Context Request
    │
    ├─ target sequence / participants / POV / author mode
    ▼
Entity Resolution
    ▼
Point-in-time Story State
    ▼
Canon Authority Resolution
    ▼
Timeline Validity
    ▼
Reveal Guard
    ▼
POV Knowledge Guard
    ▼
Safe Dependency Expansion
    ▼
Semantic Retrieval Candidates
    ▼
All retrieved candidates pass the same gates again
    ▼
Deterministic Priority + Soft Budget
    ▼
Context Manifest
    ▼
Prompt assembly (later layer)
```

Semantic retrieval is deliberately behind a `SemanticRetriever` protocol. A result with similarity `0.99` is still only a candidate. It does not become model context until the deterministic StoryOS gates allow it.

### AUTHOR mode

AUTHOR mode is intended for planning and continuity analysis. It may include true-but-unrevealed Canon, but still obeys story-time validity and authority resolution.

### POV mode

POV mode is intended for prose generation constrained to a viewpoint. Canon content must additionally be revealable and either public or explicitly known by the POV entity at the requested sequence.

Manual pins and dependency recursion never bypass these rules.

### Explainability

Every manifest records included items with reasons/priority and excluded items with a machine-readable reason, for example:

```text
not_revealed
pov_unknown
canon_ambiguous
shadowed_by_authority
timeline_inactive
budget
unknown_ref
```

Given identical canonical files, request, dependency configuration and retriever hits, the resulting manifest order is deterministic. Tests explicitly reverse retriever hit order and require byte-equivalent manifest data.

### Budget semantics

v0.3 uses a character-count soft budget, not a fake token estimate. Required participant/POV identity and point-in-time state are never dropped by this soft budget. Optional context is removed deterministically when it would exceed the budget.

A later model adapter may convert this into provider-specific token budgeting without changing the gating contract.

## Data flow

```text
Human-readable Canon / Events
          │
          ├──────────────► Story State Projector
          │                         │
          │                         ▼
          │                 Point-in-time State
          │
          ├──────────────► Canon Resolver
          │                         │
          │                         ▼
          │                 Authority Resolution
          │
          └──────────────► Context Compiler ◄──── Retrieval candidates
                                    │
                                    ▼
                             Context Manifest

AI / Import
    │
    ▼
Candidate Claim
    │
    ▼
Claim Checker ──► conflicts / duplicate / safe candidate
    │
    ▼ explicit author approval only
Canonical Event or Canon Fact
```

## Runtime layout

```text
.storyos/
  index.sqlite
  workflow.sqlite
  cache/
  logs/
```

Everything under `.storyos/` may be deleted and rebuilt without losing Canon or staged source files.
