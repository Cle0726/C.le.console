from pathlib import Path

from storyos.authority import CanonAuthority, CanonFact, CanonResolver
from storyos.claims import ClaimStager
from storyos.knowledge import KnowledgeTimeline
from storyos.project import StoryProject
from storyos.state import StoryStateProjector


KADEN = "chr_00000000000000000000000000000001"
FACT = "canon_00000000000000000000000000000001"


def demo_root() -> Path:
    return Path(__file__).parents[1] / "examples" / "demo"


def test_locked_canon_resolves_independently_of_reveal_timing():
    project = StoryProject.open(demo_root())
    resolution = CanonResolver().resolve(
        project.load_canon_facts(),
        subject=KADEN,
        predicate="identity.role",
        through_sequence=150,
    )
    assert resolution.ambiguous is False
    assert resolution.fact is not None
    assert resolution.fact.value == "protagonist"
    assert resolution.fact.authority is CanonAuthority.LOCKED
    assert resolution.fact.revealed_at(None) is False
    assert resolution.fact.revealed_at(199) is False
    assert resolution.fact.revealed_at(200) is True


def test_equal_authority_disagreement_is_ambiguous():
    facts = [
        CanonFact(
            id="canon_00000000000000000000000000000011",
            subject=KADEN,
            predicate="eye.color",
            value="blue",
            authority=CanonAuthority.CURRENT,
        ),
        CanonFact(
            id="canon_00000000000000000000000000000012",
            subject=KADEN,
            predicate="eye.color",
            value="green",
            authority=CanonAuthority.CURRENT,
        ),
    ]
    resolution = CanonResolver().resolve(facts, subject=KADEN, predicate="eye.color")
    assert resolution.fact is None
    assert resolution.ambiguous is True
    assert len(resolution.conflicts) == 2


def test_staged_claim_cannot_mutate_story_state_even_if_marked_approved():
    project = StoryProject.open(demo_root())
    claim = project.load_claims()[0]
    assert claim.status.value == "approved"

    state = StoryStateProjector().project(project.load_events(), through_sequence=150)[KADEN]
    assert state.values["location"] == "loc_00000000000000000000000000000001"
    assert "identity.role" not in state.values

    result = ClaimStager().check(
        claim,
        canon_facts=project.load_canon_facts(),
        events=project.load_events(),
    )
    assert result.can_approve is False
    assert any(issue.code == "canon_conflict" for issue in result.issues)


def test_knowledge_is_bounded_by_story_sequence():
    project = StoryProject.open(demo_root())
    timeline = KnowledgeTimeline(project.load_events())

    assert timeline.knows(KADEN, FACT, through_sequence=199) is False
    assert timeline.knows(KADEN, FACT, through_sequence=200) is True
    assert timeline.known_facts(KADEN, through_sequence=200) == {FACT}
    assert timeline.holders(FACT, through_sequence=200) == {KADEN}


def test_claim_materialization_is_an_explicit_non_persistent_step():
    project = StoryProject.open(demo_root())
    claim = project.load_claims()[0]
    event = ClaimStager().materialize_event(
        claim,
        event_id="evt_00000000000000000000000000000099",
    )

    assert event.type == "identity.role.set"
    assert event.payload["approved_claim"] == claim.id
    assert len(project.load_events()) == 2

    combined = [*project.load_events(), event]
    projected = StoryStateProjector().project(combined, through_sequence=claim.at.sequence)
    assert projected[KADEN].values["identity.role"] == "antagonist"
