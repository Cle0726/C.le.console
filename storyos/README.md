# C.le. StoryOS v1.0

StoryOS is a deterministic long-form fiction engine for manuscript management, story state, Canon safety, review/materialization workflows and AI-safe context. v1.0 adds the first stable **read-only Authoring Workspace API** intended for the desktop UI.

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
11. Every Canon create is revalidated against the current world immediately before the write.
12. **Desktop UI consumes read-only workspace/context contracts instead of reading or mutating StoryOS files directly.**

## v1.0: Authoring Workspace API

v1.0 stops adding write gates and starts exposing stable UI-facing views over the already verified data-safety pipeline.

The workspace layer is deliberately separate from the mutation CLI:

```bash
storyos-workspace snapshot PROJECT
storyos-workspace snapshot PROJECT --through 1010100
storyos-workspace entity PROJECT ENTITY_ID --through 1010100
storyos-workspace manuscript PROJECT manuscript/S01/EP01_Title.txt
```

The original `storyos` CLI remains responsible for review/materialization/Canon commit actions. `storyos-workspace` is read-only.

### Workspace snapshot

`storyos-workspace snapshot` returns `story.authoring-workspace.v1` with compact data suitable for the left navigation, dashboard and status surfaces:

```text
project metadata
story timeline boundary
manuscript metadata index
entity list
current projected state per entity
entity event / Canon / Claim counts
Canon authority summary
Claim Review summary
Materialization summary
Canon Commit readiness summary
reference diagnostics
Context Compiler / Inspector capability references
```

The snapshot does **not** include full manuscript text.

For a long-running multi-season project this matters: refreshing the dashboard should not serialize every chapter on every UI update.

### Manuscript index and document view

The snapshot indexes manuscript working copies using metadata only:

```text
project-relative path
title
season
episode
byte size
character count
line count
SHA-256
```

Full text is loaded explicitly through:

```bash
storyos-workspace manuscript PROJECT <project-relative-manuscript-path>
```

The reader accepts UTF-8 text files under the configured manuscript root (`.txt`, `.md`, `.markdown`). Absolute paths and paths escaping the manuscript root are rejected.

For the imported 《断弦之歌》 project, the importer already declares:

```yaml
paths:
  manuscript: manuscript
```

and the 36 Season 1 working copies live under `manuscript/S01/`.

### Entity view

`storyos-workspace entity` returns `story.authoring-entity.v1` for a right-side detail panel:

```text
entity identity / aliases / structured data
projected Story State at the requested boundary
knowledge and resolved plot IDs
canonical events through the boundary
Canon Facts with active/mainline-active/revealed flags
Candidate Claims
review decision + freshness/current check
materialization readiness
Canon Commit readiness + candidate SHA/path/audit identity
```

This allows a desktop authoring view to answer questions such as:

```text
Where is this character now?
What injuries/state keys are currently active?
What Canon is attached to them?
What claims still need review?
Is a reviewed claim ready for quarantine staging?
Is a quarantined candidate ready for explicit Canon commit?
```

without giving the workspace layer permission to perform those mutations.

### Historical boundary

Both snapshot and entity views accept `--through SEQUENCE`.

When omitted, the workspace uses the latest canonical Story Event sequence. When provided, projected state and visible event counts stop at that boundary. This is the UI foundation for later controls such as:

```text
Load World State @ S01E20
Load World State @ S01E36
Compare before / after a scene
```

### Read-only invariant

`AuthoringWorkspace` calls only read/plan APIs:

```text
StoryProject loaders
StoryStateProjector
ClaimReviewWorkbench.build_queue
MaterializationWorkbench.build_plan
CanonCommitWorkbench.build_plan
```

It never calls:

```text
ClaimReviewWorkbench.decide
MaterializationWorkbench.stage
CanonCommitWorkbench.commit
```

Tests hash the complete project file tree before and after workspace calls and require byte-identical results.

### Context remains a separate authority boundary

v1.0 does not duplicate the Context Compiler. AI-visible information still flows through the already established commands:

```bash
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

The desktop workspace can therefore show broad author-only state while the AI writing surface consumes a separately compiled, explainable context manifest.

## v0.9: Explicit Canon Commit Gate

v0.9 is the only StoryOS layer currently allowed to create canonical `StoryEvent` or `CanonFact` files from reviewed quarantine candidates.

Inspect first:

```bash
storyos canon-commit-plan PROJECT --claim CLAIM_ID
```

Then explicitly confirm the exact quarantine file hash:

```bash
storyos canon-commit PROJECT CLAIM_ID \
  --confirm-sha256 <candidate_sha256-from-plan> \
  --actor "author" \
  --note "approved exact reviewed candidate"
```

The gate requires current materialization safety, exact quarantine matching, SHA-256 confirmation, an immutable authorization audit written before Canon, a second current-world revalidation immediately before the write, and create-only canonical file creation.

Canonical outputs:

```text
events/committed/<event-id>.yaml
canon/committed/<canon-id>.yaml
audit/canon_commits/<audit-id>.yaml
```

Existing canonical files are never overwritten or silently adopted. A Claim that has already produced one audited canonical target cannot be reused to create a second distinct target.

## v0.8: Reviewed Claim → quarantine materialization

```bash
storyos materialization-plan PROJECT --claim CLAIM_ID
storyos materialization-stage PROJECT CLAIM_ID
```

This layer revalidates accepted reviews against current Canon/Story State and writes only to:

```text
staging/materialization/events/
staging/materialization/facts/
```

It does not mutate Canon.

## v0.7: Claim Review / Normalization

```bash
storyos claim-review PROJECT
storyos claim-decide PROJECT CLAIM_ID \
  --decision accept_event_candidate \
  --predicate injury.left_hand \
  --value-json '"numb"'
```

Review sidecars fingerprint the underlying Claim, require explicit normalization for accept decisions and remain non-canonical.

## v0.6: World State → Candidate Claims

```bash
storyos worldstate-claims PROJECT
storyos worldstate-claims PROJECT --write
```

Extraction deliberately favors precision over recall. Ambiguous subjects/groups remain unresolved rather than guessed.

A conservative pass over the supplied 《断弦之歌》 v3.9 118-scene World State ledger produced approximately 262 Candidate Claims.

## v0.5: 《断弦之歌》 v3.9 migration

```bash
storyos import-duanxian-v39 SOURCE TARGET
```

The importer verifies the mother-package manifest, snapshots the source package byte-for-byte, creates 36 Season 1 manuscript working copies, 50 deterministic character entities, 118 World State source records and one editorial-insert source record. Natural-language management prose is not automatically promoted to Canon.

## Current authoring pipeline

```text
v3.9 Mother Package
        ↓ lossless import
Imported Sources + manuscript working copies
        ↓ conservative extraction
Candidate Claims
        ↓ explicit review + normalization
Review Sidecars
        ↓ current revalidation
Quarantine Materialization Candidates
        ↓ hash-confirmed + audit-authorized commit
StoryEvent / CanonFact
        ↓
Story State / Knowledge / Canon Authority
        ├──────────────→ Authoring Workspace API (author/UI view)
        ↓
Canonical Retriever + Context Compiler
        ↓
POV / AUTHOR Context Manifest + Inspector
        ↓
AI-assisted long-form continuation
```

## Useful commands

```bash
# read-only desktop/UI views
storyos-workspace snapshot PROJECT
storyos-workspace entity PROJECT ENTITY_ID --through 1010100
storyos-workspace manuscript PROJECT manuscript/S01/EP01_Title.txt

# import/extraction/review/commit pipeline
storyos import-duanxian-v39 SOURCE TARGET
storyos worldstate-claims PROJECT --write
storyos claim-review PROJECT
storyos claim-decide PROJECT CLAIM_ID --decision defer --note "..."
storyos materialization-plan PROJECT --claim CLAIM_ID
storyos materialization-stage PROJECT CLAIM_ID
storyos canon-commit-plan PROJECT --claim CLAIM_ID
storyos canon-commit PROJECT CLAIM_ID --confirm-sha256 HASH --actor AUTHOR --note "..."

# canonical inspection/context
storyos validate PROJECT
storyos state PROJECT --through 1010100
storyos canon PROJECT SUBJECT PREDICATE --through 1010100
storyos knowledge PROJECT CHARACTER --through 1010100
storyos retrieve PROJECT "凯登"
storyos context PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..."
storyos context-inspect PROJECT --through 1010100 --participant CHAR_ID --pov CHAR_ID --mode pov --query "..." --ref REF
```

## Verification

The first functional v1.0 workspace head passed **81 StoryOS tests** on Ubuntu and Windows with Python 3.11 and 3.13 test steps. The final documentation head is validated again before v1.0 is frozen.

The v1.0 tests include deterministic workspace output, timeline-boundary projection, entity workflow aggregation, manuscript metadata/content separation, absolute/path-traversal blocking and byte-identical project-tree checks before/after workspace reads.

v0.9's Canon-write fault-injection tests remain in the same suite, so v1.0 continues to verify both the new read-only UI layer and the existing audited Canon mutation boundary.

## Next layer

After v1.0 is frozen, the next useful work is the **desktop bridge and actual C.le. StoryOS authoring UI**: Tauri/TypeScript should call the workspace/context contracts, render manuscript/entity/workflow panels, and keep all mutation buttons routed through the existing explicit review/materialization/commit commands rather than writing project files directly.
