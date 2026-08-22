from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from storyos.claim_review import ClaimReviewWorkbench
from storyos.cli import main as cli_main
from storyos.ids import stable_id
from storyos.materialization import MaterializationError, MaterializationWorkbench
from storyos.project import StoryProject


CHAR = stable_id("character", "materialization-test", "character")
CLAIM = stable_id("claim", "materialization-test", "claim")
CANON = stable_id("canon", "materialization-test", "canon-role")


def _write_yaml(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
        newline="\n",
    )


def _make_project(root: Path) -> StoryProject:
    _write_yaml(
        root / "storyos.yaml",
        {
            "schema": "story.project.v1",
            "id": "materialization-test",
            "name": "Materialization Test",
            "language": "en",
        },
    )
    _write_yaml(
        root / "entities" / "character.yaml",
        {
            "schema": "story.entity.v1",
            "id": CHAR,
            "kind": "character",
            "name": "Test Character",
            "slug": "test-character",
            "aliases": [],
            "data": {},
        },
    )
    _write_yaml(
        root / "staging" / "claims" / "claim.yaml",
        {
            "schema": "story.claim.v1",
            "id": CLAIM,
            "subject": CHAR,
            "predicate": "condition.note",
            "value": {"text": "left hand is numb"},
            "at": {"sequence": 1010101, "season": 1, "episode": 1, "scene": 1},
            "confidence": 0.9,
            "source": {"kind": "test"},
            "proposed_authority": "draft",
            "status": "pending",
        },
    )
    return StoryProject.open(root)


def _canonical_snapshot(project: StoryProject):
    return project.load_events(), project.load_canon_facts()


def _accept_event(project: StoryProject, *, predicate="injury.left_hand", value="numb"):
    return ClaimReviewWorkbench().decide(
        project,
        claim_id=CLAIM,
        decision="accept_event_candidate",
        normalized_predicate=predicate,
        normalized_value=value,
        note="reviewed event candidate",
    )


def _accept_fact(project: StoryProject, *, predicate="identity.role", value="protagonist"):
    return ClaimReviewWorkbench().decide(
        project,
        claim_id=CLAIM,
        decision="accept_fact_candidate",
        normalized_predicate=predicate,
        normalized_value=value,
        note="reviewed fact candidate",
    )


def _write_role_canon(project: StoryProject, value: str) -> None:
    _write_yaml(
        project.root / "canon" / "role.yaml",
        {
            "schema": "story.canon.v1",
            "id": CANON,
            "subject": CHAR,
            "predicate": "identity.role",
            "value": value,
            "authority": "locked",
            "valid_from": 0,
            "source": {"kind": "test"},
            "tags": ["identity"],
        },
    )


def test_unreviewed_and_deferred_claims_are_not_ready(tmp_path):
    project = _make_project(tmp_path / "project")
    workbench = MaterializationWorkbench()

    unreviewed = workbench.build_plan(project, claim_id=CLAIM)["items"][0]
    assert unreviewed["ready"] is False
    assert unreviewed["reasons"] == ["unreviewed"]

    ClaimReviewWorkbench().decide(project, claim_id=CLAIM, decision="defer", note="later")
    deferred = workbench.build_plan(project, claim_id=CLAIM)["items"][0]
    assert deferred["ready"] is False
    assert deferred["reasons"] == ["decision_defer"]


def test_stale_review_is_rejected_before_rechecking_target(tmp_path):
    project = _make_project(tmp_path / "project")
    _accept_event(project)

    path = project.root / "staging" / "claims" / "claim.yaml"
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    raw["confidence"] = 0.8
    _write_yaml(path, raw)

    item = MaterializationWorkbench().build_plan(StoryProject.open(project.root), claim_id=CLAIM)["items"][0]
    assert item["ready"] is False
    assert item["reasons"] == ["stale_review"]
    with pytest.raises(MaterializationError, match="stale_review"):
        MaterializationWorkbench().stage(StoryProject.open(project.root), claim_id=CLAIM)


def test_normalized_target_is_rechecked_against_current_canon(tmp_path):
    project = _make_project(tmp_path / "project")
    _accept_fact(project, predicate="identity.role", value="antagonist")

    # Canon changes after review. Materialization must use the current world, not the old review-time check.
    _write_role_canon(project, "protagonist")
    reopened = StoryProject.open(project.root)
    item = MaterializationWorkbench().build_plan(reopened, claim_id=CLAIM)["items"][0]

    assert item["ready"] is False
    assert "current_conflict" in item["reasons"]
    assert any(issue["code"] == "canon_conflict" for issue in item["check"]["issues"])
    with pytest.raises(MaterializationError, match="current_conflict"):
        MaterializationWorkbench().stage(reopened, claim_id=CLAIM)


def test_existing_canon_duplicate_is_not_staged_again(tmp_path):
    project = _make_project(tmp_path / "project")
    _accept_fact(project, predicate="identity.role", value="protagonist")
    _write_role_canon(project, "protagonist")

    item = MaterializationWorkbench().build_plan(StoryProject.open(project.root), claim_id=CLAIM)["items"][0]
    assert item["ready"] is False
    assert "already_canonical_duplicate" in item["reasons"]
    assert item["check"]["duplicate_of"] == CANON


def test_ready_event_candidate_is_deterministic_idempotent_and_noncanonical(tmp_path):
    first_project = _make_project(tmp_path / "a")
    second_project = _make_project(tmp_path / "b")
    _accept_event(first_project)
    _accept_event(second_project)

    first_plan = MaterializationWorkbench().build_plan(first_project, claim_id=CLAIM)
    second_plan = MaterializationWorkbench().build_plan(second_project, claim_id=CLAIM)
    first_item = first_plan["items"][0]
    second_item = second_plan["items"][0]

    assert first_item == second_item
    assert first_item["ready"] is True
    assert first_item["kind"] == "event"
    payload = first_item["candidate"]["canonical_payload"]
    assert payload["type"] == "injury.left_hand.set"
    assert payload["payload"]["value"] == "numb"

    before = _canonical_snapshot(first_project)
    candidate, result = MaterializationWorkbench().stage(first_project, claim_id=CLAIM)
    assert result == "created"
    assert candidate["policy"]["canonical_mutation"] is False
    assert _canonical_snapshot(first_project) == before

    same, unchanged = MaterializationWorkbench().stage(first_project, claim_id=CLAIM)
    assert unchanged == "unchanged"
    assert same == candidate
    assert _canonical_snapshot(first_project) == before

    target = first_project.root / "staging" / "materialization" / "events" / f"{first_item['target_id']}.yaml"
    assert target.is_file()


def test_ready_fact_candidate_is_quarantined_with_explicit_assumptions(tmp_path):
    project = _make_project(tmp_path / "project")
    _accept_fact(project, predicate="identity.role", value="protagonist")
    before = _canonical_snapshot(project)

    item = MaterializationWorkbench().build_plan(project, claim_id=CLAIM)["items"][0]
    assert item["ready"] is True
    assert item["kind"] == "fact"
    payload = item["candidate"]["canonical_payload"]
    assert payload["predicate"] == "identity.role"
    assert payload["value"] == "protagonist"
    assert payload["authority"] == "draft"
    assert payload["valid_from"] == 1010101
    assert any("valid_from" in text for text in item["candidate"]["assumptions"])

    candidate, result = MaterializationWorkbench().stage(project, claim_id=CLAIM)
    assert result == "created"
    assert candidate["kind"] == "fact"
    assert _canonical_snapshot(project) == before
    assert project.load_events() == before[0]
    assert project.load_canon_facts() == before[1]


def test_cli_plan_and_stage_keep_canonical_files_unchanged(tmp_path, monkeypatch, capsys):
    project = _make_project(tmp_path / "project")
    _accept_event(project)
    before = _canonical_snapshot(project)

    monkeypatch.setattr(
        "sys.argv",
        ["storyos", "materialization-plan", str(project.root), "--claim", CLAIM],
    )
    cli_main()
    plan = json.loads(capsys.readouterr().out)
    assert plan["schema"] == "story.materialization-plan.v1"
    assert plan["summary"]["ready"] == 1
    assert plan["policy"]["canonical_mutation"] is False

    monkeypatch.setattr(
        "sys.argv",
        ["storyos", "materialization-stage", str(project.root), CLAIM],
    )
    cli_main()
    staged = json.loads(capsys.readouterr().out)
    assert staged["schema"] == "story.materialization-result.v1"
    assert staged["result"] == "created"
    assert staged["candidate"]["kind"] == "event"
    assert staged["policy"]["canonical_mutation"] is False
    assert _canonical_snapshot(StoryProject.open(project.root)) == before
