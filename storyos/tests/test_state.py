from storyos.events import StoryEvent
from storyos.state import StoryStateProjector


SUBJECT = "chr_00000000000000000000000000000001"


def event(event_id: int, sequence: int, event_type: str, payload: dict):
    return StoryEvent.from_mapping({
        "id": f"evt_{event_id:032x}",
        "subject": SUBJECT,
        "type": event_type,
        "at": {"sequence": sequence},
        "payload": payload,
    })


def test_point_in_time_projection_is_deterministic():
    events = [
        event(3, 30, "location.changed", {"value": "loc_c"}),
        event(1, 10, "location.changed", {"value": "loc_a"}),
        event(2, 20, "knowledge.gained", {"fact": "canon_secret"}),
    ]
    projector = StoryStateProjector()

    at_15 = projector.project(events, through_sequence=15)[SUBJECT]
    at_30 = projector.project(events, through_sequence=30)[SUBJECT]

    assert at_15.values["location"] == "loc_a"
    assert "canon_secret" not in at_15.knowledge
    assert at_30.values["location"] == "loc_c"
    assert "canon_secret" in at_30.knowledge


def test_same_sequence_tie_breaks_by_event_id():
    events = [
        event(2, 10, "status.changed", {"value": "b"}),
        event(1, 10, "status.changed", {"value": "a"}),
    ]
    state = StoryStateProjector().project(events)[SUBJECT]
    assert state.values["status"] == "b"
