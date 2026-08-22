from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
import yaml

from storyos.claim_review import ClaimReviewError, ClaimReviewWorkbench, ReviewDecision
from storyos.cli import main as cli_main
from storyos.project import StoryProject


CLAIM = "clm_00000000000000000000000000000001"
KADEN = "chr_00000000000000000000000000000001"


def _copy_demo(tmp_path: Path) -> StoryProject:
    source = Path(__file__).resolve().parents[1] / "examples" / "demo"
    target = tmp_path / "demo"
    shutil.copytree(source, target)
    return StoryProject.open(target)


def _canonical_snapshot(project: StoryProject):
    return project.load_events(), project.load_canon_facts()


def test_review_queue_exposes_claim_checks_and_is_noncanonical(tmp_path):
    project = _copy_demo(tmp_path)
    before_events, before_facts = _canonical_snapshot(project)
    queue = ClaimReviewWorkbench().build_queue(project)

    assert queue["schema"] == "story.claim-review-queue.v1"
    assert queue["summary"]["claims"] == 1
    assert queue["summary"]["blocked_by_current_canon_or_state"] == 1
    assert queue["summary"]["reviewed"] == 0
    assert queue["items"][0]["claim"]["id"] == CLAIM
    assert queue["items"][0]["claim"]["subject"] == KADEN
    assert queue["items"][0]["check"]["can_approve"] is False
    assert any(issue["code"] == "canon_conflict" for issue in queue["items"][0]["check"]["issues"])
    assert queue["policy"]["review_decisions_are_noncanonical"] is True

    after_events, after_facts = _canonical_snapshot(project)
    assert after_events == before_events
    assert after_facts == before_facts


def test_reject_decision_is_sidecar_and_does_not_change_claim_status(tmp_path):
    project = _copy_demo(tmp_path)
    workbench = ClaimReviewWorkbench()
    before_claim = project.load_claims()[0]
    before_events, before_facts = _canonical_snapshot(project)

    review, result = workbench.decide(
        project,
        claim_id=CLAIM,
        decision=ReviewDecision.REJECT,
        note="conflicts with locked identity canon",
    )

    assert result == "created"
    assert review.decision is ReviewDecision.REJECT
    assert review.normalized is None
    after_claim = project.load_claims()[0]
    assert after_claim == before_claim
    assert after_claim.status.value == "approved"  # legacy source status remains irrelevant
    after_events, after_facts = _canonical_snapshot(project)
    assert after_events == before_events
    assert after_facts == before_facts

    queue = workbench.build_queue(project)
    assert queue["summary"]["reviewed"] == 1
    assert queue["summary"]["decisions"] == {"reject": 1}
    assert queue["items"][0]["review_stale"] is False


def test_accept_decision_requires_explicit_normalized_target(tmp_path):
    project = _copy_demo(tmp_path)
    workbench = ClaimReviewWorkbench()
    before_events, before_facts = _canonical_snapshot(project)

    with pytest.raises(ClaimReviewError, match="require --predicate"):
        workbench.decide(
            project,
            claim_id=CLAIM,
            decision=ReviewDecision.ACCEPT_EVENT_CANDIDATE,
        )

    with pytest.raises(ClaimReviewError, match="require --value-json"):
        workbench.decide(
            project,
            claim_id=CLAIM,
            decision=ReviewDecision.ACCEPT_EVENT_CANDIDATE,
            normalized_predicate="identity.role",
        )

    review, result = workbench.decide(
        project,
        claim_id=CLAIM,
        decision=ReviewDecision.ACCEPT_EVENT_CANDIDATE,
        normalized_predicate="identity.role",
        normalized_value="antagonist",
        note="reviewed as event candidate only",
    )
    assert result == "created"
    assert review.normalized == {"predicate": "identity.role", "value": "antagonist"}
    assert review.as_mapping()["policy"]["canonical_mutation"] is False
    after_events, after_facts = _canonical_snapshot(project)
    assert after_events == before_events
    assert after_facts == before_facts


def test_different_review_requires_explicit_replace(tmp_path):
    project = _copy_demo(tmp_path)
    workbench = ClaimReviewWorkbench()

    _, first = workbench.decide(project, claim_id=CLAIM, decision="defer", note="needs author check")
    assert first == "created"

    with pytest.raises(ClaimReviewError, match="review already exists"):
        workbench.decide(project, claim_id=CLAIM, decision="reject", note="later decision")

    review, result = workbench.decide(
        project,
        claim_id=CLAIM,
        decision="reject",
        note="later decision",
        replace=True,
    )
    assert result == "replaced"
    assert review.decision is ReviewDecision.REJECT

    same, unchanged = workbench.decide(
        project,
        claim_id=CLAIM,
        decision="reject",
        note="later decision",
    )
    assert unchanged == "unchanged"
    assert same == review


def test_review_becomes_stale_when_source_claim_changes(tmp_path):
    project = _copy_demo(tmp_path)
    workbench = ClaimReviewWorkbench()
    workbench.decide(project, claim_id=CLAIM, decision="defer", note="review later")

    claim_path = project.root / "staging" / "claims" / "kaden-role-conflict.yaml"
    raw = yaml.safe_load(claim_path.read_text(encoding="utf-8"))
    raw["value"] = "rival"
    claim_path.write_text(
        yaml.safe_dump(raw, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
        newline="\n",
    )

    queue = workbench.build_queue(StoryProject.open(project.root))
    assert queue["summary"]["stale_reviews"] == 1
    assert queue["items"][0]["review_stale"] is True


def test_cli_review_and_decision_are_explicit_sidecar_operations(tmp_path, monkeypatch, capsys):
    project = _copy_demo(tmp_path)
    before_events, before_facts = _canonical_snapshot(project)

    monkeypatch.setattr("sys.argv", ["storyos", "claim-review", str(project.root), "--claim", CLAIM])
    cli_main()
    queue = json.loads(capsys.readouterr().out)
    assert queue["summary"]["claims"] == 1
    assert queue["summary"]["reviewed"] == 0

    monkeypatch.setattr(
        "sys.argv",
        [
            "storyos",
            "claim-decide",
            str(project.root),
            CLAIM,
            "--decision",
            "accept_fact_candidate",
            "--predicate",
            "identity.role",
            "--value-json",
            '"antagonist"',
            "--note",
            "normalized but not materialized",
        ],
    )
    cli_main()
    result = json.loads(capsys.readouterr().out)
    assert result["schema"] == "story.claim-review-result.v1"
    assert result["result"] == "created"
    assert result["review"]["decision"] == "accept_fact_candidate"
    assert result["policy"]["canonical_mutation"] is False

    reopened = StoryProject.open(project.root)
    after_events, after_facts = _canonical_snapshot(reopened)
    assert after_events == before_events
    assert after_facts == before_facts
