# StoryOS v0.4 Retrieval Contract

## Retrieval is not authority

A retriever can only nominate stable refs. It never decides whether a ref is legal model context.

The boundary is:

```text
query
  ↓
Retriever
  ↓ refs + scores only
Context Compiler
  ↓
Timeline / Authority / Reveal / Knowledge / Visibility / Budget
  ↓
Context Manifest
```

The Context Compiler must remain correct even when the retriever returns a future secret with score `1.0`.

## v0.4 canonical corpus

`SQLiteCanonicalRetriever` reads the disposable `.storyos/index.sqlite` built from canonical source files. Its search corpus is intentionally restricted to:

```text
entities
canon_facts with authority >= planning
```

The following indexed data is excluded from retrieval:

```text
events
staged_claims
claim_fts
```

Events remain available to deterministic state/knowledge projection, not free-text candidate retrieval. Candidate Claims remain staging data until explicit author approval.

## Determinism

For identical index contents, normalized query and limit, the adapter returns the same ordered `(ref, score)` sequence.

Ordering is:

```text
score descending
ref ascending as deterministic tie-breaker
```

Scores are bounded to `[0, 1]`. v0.4 uses deterministic lexical scoring rather than claiming embedding similarity.

## CJK handling

The adapter uses Unicode NFKC normalization and derives two-character terms from CJK runs longer than two characters. This provides useful deterministic matching for current Chinese novel data without depending on a platform-specific tokenizer.

A future embedding/vector adapter can improve semantic recall without changing the Context Compiler contract.

## Runtime index recovery

The library adapter raises `RetrievalIndexError` for missing/unsupported index data. CLI commands may rebuild `.storyos/index.sqlite` from canonical files and retry. Rebuilding runtime data must never modify manuscript, Canon, Event or staging source files.

## Inspection

`ContextInspector` consumes an already-compiled `ContextManifest`. It reports:

- retrieval score for a ref, when present;
- whether the ref was included;
- inclusion reasons and priority;
- exclusion reasons/details;
- blocked retrieval counts;
- context budget usage.

It does not re-run retrieval or re-decide Canon. Therefore the debugger explains the exact manifest rather than generating a second potentially different answer.
