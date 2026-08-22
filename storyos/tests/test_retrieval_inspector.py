from pathlib import Path

from storyos.context import ContextCompiler, ContextMode, ContextRequest
from storyos.index import StoryIndex
from storyos.inspector import ContextInspector
from storyos.project import StoryProject
from storyos.retrieval import SQLiteCanonicalRetriever


KADEN = "chr_00000000000000000000000000000001"
FACT = "canon_00000000000000000000000000000001"
CLAIM = "clm_00000000000000000000000000000001"


def demo_root() -> Path:
    return Path(__file__).parents[1] / "examples" / "demo"


def build_retriever(tmp_path):
    project = StoryProject.open(demo_root())
    db = tmp_path / "index.sqlite"
    StoryIndex(db).rebuild(project)
    return project, SQLiteCanonicalRetriever(db)


def refs(hits):
    return [hit.ref for hit in hits]


def test_retriever_finds_chinese_entity_name(tmp_path):
    _, retriever = build_retriever(tmp_path)
    hits = retriever.search("凯登", limit=8)
    assert hits
    assert hits[0].ref == KADEN
    assert hits[0].score == 1.0


def test_retriever_finds_canon_but_never_staged_claims(tmp_path):
    _, retriever = build_retriever(tmp_path)
    canon_hits = retriever.search("identity role", limit=8)
    assert FACT in refs(canon_hits)

    claim_only_hits = retriever.search("antagonist", limit=8)
    assert CLAIM not in refs(claim_only_hits)
    assert claim_only_hits == ()


def test_retrieval_order_is_deterministic(tmp_path):
    _, retriever = build_retriever(tmp_path)
    first = retriever.search("protagonist", limit=8)
    second = retriever.search("protagonist", limit=8)
    assert first == second
    assert refs(first) == sorted(refs(first), key=lambda ref: (-next(hit.score for hit in first if hit.ref == ref), ref))


def test_real_retrieval_still_cannot_bypass_context_guards(tmp_path):
    project, retriever = build_retriever(tmp_path)
    manifest = ContextCompiler(project, retriever=retriever).compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="protagonist",
            mode=ContextMode.POV,
        )
    )

    assert FACT in {hit.ref for hit in manifest.retrieval_hits}
    assert FACT not in {item.ref for item in manifest.included}
    assert "not_revealed" in {
        item.reason for item in manifest.excluded if item.ref == FACT
    }


def test_context_inspector_explains_blocked_retrieval(tmp_path):
    project, retriever = build_retriever(tmp_path)
    manifest = ContextCompiler(project, retriever=retriever).compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="protagonist",
            mode=ContextMode.POV,
        )
    )

    inspector = ContextInspector()
    trace = inspector.trace(manifest, FACT)
    summary = inspector.summarize(manifest)

    assert trace.retrieval_score is not None
    assert trace.included is False
    assert "not_revealed" in trace.exclusion_reasons
    assert FACT in summary["blocked_retrieval_refs"]
    assert summary["exclusion_reason_counts"]["not_revealed"] >= 1


def test_context_inspector_marks_retrieved_fact_included_after_reveal(tmp_path):
    project, retriever = build_retriever(tmp_path)
    manifest = ContextCompiler(project, retriever=retriever).compile(
        ContextRequest(
            through_sequence=200,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="protagonist",
            mode=ContextMode.POV,
        )
    )

    trace = ContextInspector().trace(manifest, FACT)
    assert trace.retrieval_score is not None
    assert trace.included is True
    assert trace.kind == "canon"
    assert "semantic_retrieval" in trace.reasons
