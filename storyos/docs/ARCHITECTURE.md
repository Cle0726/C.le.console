# StoryOS v0.1 Architecture

## Source of truth

Canonical story data lives in human-readable project files. Runtime databases are disposable and rebuildable.

## Core invariants

1. Display names and file paths are never identifiers.
2. Story state is derived from ordered Story Events.
3. Point-in-time reads accept an explicit sequence boundary.
4. Unknown event types do not mutate projected state until a projector rule exists.
5. SQLite stores indexes and runtime state only.
6. Future AI systems may propose candidate claims, but Canon changes require an explicit approval path.

## Event ordering

Events are replayed by `(at.sequence, id)`. The event ID is the deterministic tie-breaker when two events share a sequence.

## Runtime layout

```text
.storyos/
  index.sqlite
  workflow.sqlite
  cache/
  logs/
```

Everything under `.storyos/` may be deleted and rebuilt without losing Canon.
