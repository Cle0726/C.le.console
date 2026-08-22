import json
import shutil
from pathlib import Path

from storyos.cli import main as cli_main


KADEN = "chr_00000000000000000000000000000001"
FACT = "canon_00000000000000000000000000000001"


def demo_root() -> Path:
    return Path(__file__).parents[1] / "examples" / "demo"


def copied_demo(tmp_path: Path) -> Path:
    target = tmp_path / "demo"
    shutil.copytree(demo_root(), target)
    return target


def test_retrieve_cli_builds_runtime_index_and_returns_canonical_hits(tmp_path, monkeypatch, capsys):
    project = copied_demo(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        ["storyos", "retrieve", str(project), "凯登", "--limit", "8"],
    )
    cli_main()
    payload = json.loads(capsys.readouterr().out)

    assert payload["schema"] == "story.retrieval.v1"
    assert payload["hits"][0]["ref"] == KADEN
    assert (project / ".storyos" / "index.sqlite").is_file()


def test_retrieve_cli_does_not_surface_staged_claim_content(tmp_path, monkeypatch, capsys):
    project = copied_demo(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        ["storyos", "retrieve", str(project), "antagonist"],
    )
    cli_main()
    payload = json.loads(capsys.readouterr().out)
    assert payload["hits"] == []


def test_context_cli_runs_real_retrieval_through_spoiler_guards(tmp_path, monkeypatch, capsys):
    project = copied_demo(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        [
            "storyos",
            "context",
            str(project),
            "--through",
            "150",
            "--participant",
            KADEN,
            "--pov",
            KADEN,
            "--mode",
            "pov",
            "--query",
            "protagonist",
        ],
    )
    cli_main()
    payload = json.loads(capsys.readouterr().out)

    assert any(hit["ref"] == FACT for hit in payload["retrieval_hits"])
    assert any(
        item["ref"] == FACT and item["reason"] == "not_revealed"
        for item in payload["excluded"]
    )


def test_context_inspect_cli_explains_one_blocked_ref(tmp_path, monkeypatch, capsys):
    project = copied_demo(tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        [
            "storyos",
            "context-inspect",
            str(project),
            "--through",
            "150",
            "--participant",
            KADEN,
            "--pov",
            KADEN,
            "--mode",
            "pov",
            "--query",
            "protagonist",
            "--ref",
            FACT,
        ],
    )
    cli_main()
    payload = json.loads(capsys.readouterr().out)

    assert payload["schema"] == "story.context-inspection.v1"
    assert payload["trace"]["ref"] == FACT
    assert payload["trace"]["included"] is False
    assert payload["trace"]["retrieval_score"] is not None
    assert "not_revealed" in payload["trace"]["exclusion_reasons"]
