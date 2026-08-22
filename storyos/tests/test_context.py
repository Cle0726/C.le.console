from pathlib import Path

import pytest

from storyos.context import (
    ContextCompiler,
    ContextMode,
    ContextRequest,
    RetrievalHit,
)
from storyos.project import StoryProject


KADEN = "chr_00000000000000000000000000000001"
FACT = "canon_00000000000000000000000000000001"
UNKNOWN = "canon_ffffffffffffffffffffffffffffffff"


def demo_root() -> Path:
    return Path(__file__).parents[1] / "examples" / "demo"


class FakeRetriever:
    def __init__(self, hits):
        self.hits = hits

    def search(self, query: str, *, limit: int = 8):
        return self.hits[:limit]


def excluded_reasons(manifest, ref: str) -> set[str]:
    return {item.reason for item in manifest.excluded if item.ref == ref}


def included_refs(manifest) -> set[str]:
    return {item.ref for item in manifest.included}


def test_semantic_retrieval_cannot_bypass_future_reveal_or_pov_knowledge():
    project = StoryProject.open(demo_root())
    compiler = ContextCompiler(
        project,
        retriever=FakeRetriever([RetrievalHit(FACT, 0.99)]),
    )
    manifest = compiler.compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="identity role",
            mode=ContextMode.POV,
        )
    )

    assert FACT not in included_refs(manifest)
    assert "not_revealed" in excluded_reasons(manifest, FACT)
    assert "protagonist" not in manifest.render()


def test_manual_pin_cannot_bypass_spoiler_guard():
    project = StoryProject.open(demo_root())
    manifest = ContextCompiler(project).compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            pov=KADEN,
            pinned=(FACT,),
            mode=ContextMode.POV,
        )
    )

    assert FACT not in included_refs(manifest)
    assert "not_revealed" in excluded_reasons(manifest, FACT)


def test_pov_context_includes_fact_once_revealed_and_known():
    project = StoryProject.open(demo_root())
    compiler = ContextCompiler(
        project,
        retriever=FakeRetriever([RetrievalHit(FACT, 0.99)]),
    )
    manifest = compiler.compile(
        ContextRequest(
            through_sequence=200,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="identity role",
            mode=ContextMode.POV,
        )
    )

    assert FACT in included_refs(manifest)
    assert "protagonist" in manifest.render()


def test_author_context_can_include_true_but_unrevealed_fact():
    project = StoryProject.open(demo_root())
    manifest = ContextCompiler(project).compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            mode=ContextMode.AUTHOR,
        )
    )

    assert FACT in included_refs(manifest)


def test_dependencies_activate_only_after_safe_parent_and_still_use_guards():
    project = StoryProject.open(demo_root())
    compiler = ContextCompiler(project, dependencies={KADEN: (FACT,)})

    pov_manifest = compiler.compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            pov=KADEN,
            mode=ContextMode.POV,
        )
    )
    assert FACT not in included_refs(pov_manifest)
    assert "not_revealed" in excluded_reasons(pov_manifest, FACT)

    author_manifest = compiler.compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            mode=ContextMode.AUTHOR,
        )
    )
    fact_item = next(item for item in author_manifest.included if item.ref == FACT)
    assert f"dependency_of:{KADEN}" in fact_item.reasons


def test_soft_budget_never_drops_required_participant_identity_or_state():
    project = StoryProject.open(demo_root())
    manifest = ContextCompiler(project).compile(
        ContextRequest(
            through_sequence=150,
            participants=(KADEN,),
            mode=ContextMode.AUTHOR,
            max_chars=0,
        )
    )

    refs = included_refs(manifest)
    assert KADEN in refs
    assert f"state:{KADEN}@150" in refs
    assert FACT not in refs
    assert "budget" in excluded_reasons(manifest, FACT)


def test_unknown_semantic_reference_is_explainably_excluded():
    project = StoryProject.open(demo_root())
    compiler = ContextCompiler(
        project,
        retriever=FakeRetriever([RetrievalHit(UNKNOWN, 1.0)]),
    )
    manifest = compiler.compile(
        ContextRequest(
            through_sequence=200,
            participants=(KADEN,),
            pov=KADEN,
            semantic_query="unknown",
            mode=ContextMode.POV,
        )
    )

    assert "unknown_ref" in excluded_reasons(manifest, UNKNOWN)


def test_retrieval_order_does_not_change_context_manifest():
    project = StoryProject.open(demo_root())
    request = ContextRequest(
        through_sequence=200,
        participants=(KADEN,),
        pov=KADEN,
        semantic_query="same query",
        mode=ContextMode.POV,
    )
    first = ContextCompiler(
        project,
        retriever=FakeRetriever([
            RetrievalHit(FACT, 0.8),
            RetrievalHit(UNKNOWN, 0.8),
        ]),
    ).compile(request)
    second = ContextCompiler(
        project,
        retriever=FakeRetriever([
            RetrievalHit(UNKNOWN, 0.8),
            RetrievalHit(FACT, 0.8),
        ]),
    ).compile(request)

    assert first.as_dict() == second.as_dict()
    assert first.render() == second.render()


def test_pov_context_requires_explicit_pov_identity():
    project = StoryProject.open(demo_root())
    with pytest.raises(ValueError, match="requires pov"):
        ContextCompiler(project).compile(
            ContextRequest(
                through_sequence=150,
                participants=(KADEN,),
                mode=ContextMode.POV,
            )
        )
