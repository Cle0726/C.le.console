# C.le. StoryOS v0.1

StoryOS is the deterministic story-state foundation for long-form fiction projects.

This workspace starts with four non-negotiable foundations:

1. Human-readable project files are the canonical source of truth.
2. Stable IDs are independent from display names and file names.
3. Story state is derived from append-oriented story events.
4. SQLite indexes and workflow data are rebuildable runtime artifacts, never Canon.

## v0.1 scope

- Project manifest and folder protocol
- Stable typed identifiers
- Event schema and point-in-time state projection
- Rebuildable SQLite/FTS index
- Minimal CLI for init, validate, index, and state inspection
- Unit tests for deterministic state replay

AI writing, embeddings, desktop UI, and Git automation are intentionally outside this first foundation slice.
