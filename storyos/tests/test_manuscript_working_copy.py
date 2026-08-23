from __future__ import annotations

import codecs
import hashlib
import json
import tempfile
from pathlib import Path

import pytest

from storyos.manuscript_working_copy import (
    ManuscriptConflictError,
    ManuscriptWorkingCopy,
    ManuscriptWorkingCopyError,
)
from storyos.manuscript_working_copy_cli import _consume_payload, _payload_path
from storyos.project import StoryProject


def _project(tmp_path: Path, *, raw: bytes = b"first draft\n") -> tuple[StoryProject, Path]:
    (tmp_path / "storyos.yaml").write_text(
        "\n".join(
            [
                "schema: story.project.v1",
                "id: project_test",
                "name: Test Story",
                "language: zh-CN",
                "paths:",
                "  manuscript: manuscript",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    manuscript_dir = tmp_path / "manuscript" / "S01"
    manuscript_dir.mkdir(parents=True)
    path = manuscript_dir / "EP01_Test.md"
    path.write_bytes(raw)
    return StoryProject.open(tmp_path), path


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def test_save_replaces_existing_manuscript_and_returns_new_sha(tmp_path: Path) -> None:
    original = "第一稿\n"
    project, path = _project(tmp_path, raw=original.encode("utf-8"))

    result = ManuscriptWorkingCopy().save(
        project,
        "manuscript/S01/EP01_Test.md",
        expected_sha256=_sha(original.encode("utf-8")),
        content="第二稿\n新增一行\n",
    )

    assert result["schema"] == "story.manuscript-save.v1"
    assert result["status"] == "saved"
    assert result["previous_sha256"] == _sha(original.encode("utf-8"))
    assert result["sha256"] == _sha("第二稿\n新增一行\n".encode("utf-8"))
    assert result["policy"] == {
        "manuscript_mutation": True,
        "canonical_mutation": False,
        "staging_mutation": False,
    }
    assert path.read_text(encoding="utf-8") == "第二稿\n新增一行\n"
    assert not list(path.parent.glob(f".{path.name}.storyos-*.tmp"))


def test_save_conflict_never_overwrites_newer_disk_content(tmp_path: Path) -> None:
    original = b"loaded version\n"
    project, path = _project(tmp_path, raw=original)
    expected = _sha(original)
    path.write_bytes(b"external change\n")

    with pytest.raises(ManuscriptConflictError) as exc_info:
        ManuscriptWorkingCopy().save(
            project,
            "manuscript/S01/EP01_Test.md",
            expected_sha256=expected,
            content="editor change\n",
        )

    assert exc_info.value.expected_sha256 == expected
    assert exc_info.value.current_sha256 == _sha(b"external change\n")
    assert path.read_bytes() == b"external change\n"


def test_save_preserves_utf8_bom(tmp_path: Path) -> None:
    raw = codecs.BOM_UTF8 + "旧正文\n".encode("utf-8")
    project, path = _project(tmp_path, raw=raw)

    result = ManuscriptWorkingCopy().save(
        project,
        "manuscript/S01/EP01_Test.md",
        expected_sha256=_sha(raw),
        content="新正文\n",
    )

    assert result["status"] == "saved"
    assert path.read_bytes().startswith(codecs.BOM_UTF8)
    assert path.read_text(encoding="utf-8-sig") == "新正文\n"


def test_save_rejects_path_escape(tmp_path: Path) -> None:
    project, path = _project(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("do not touch", encoding="utf-8")

    with pytest.raises(ManuscriptWorkingCopyError):
        ManuscriptWorkingCopy().save(
            project,
            "../outside.md",
            expected_sha256=_sha(path.read_bytes()),
            content="overwrite",
        )

    assert outside.read_text(encoding="utf-8") == "do not touch"


def test_save_rejects_manuscript_symlink(tmp_path: Path) -> None:
    project, path = _project(tmp_path)
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    path.unlink()
    try:
        path.symlink_to(outside)
    except OSError:
        pytest.skip("symlink creation is unavailable on this runner")

    with pytest.raises(ManuscriptWorkingCopyError, match="symlinks"):
        ManuscriptWorkingCopy().save(
            project,
            "manuscript/S01/EP01_Test.md",
            expected_sha256=_sha(outside.read_bytes()),
            content="overwrite",
        )

    assert outside.read_text(encoding="utf-8") == "outside"


def test_temp_payload_name_is_strict_and_consumed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tempfile, "tempdir", str(tmp_path))
    name = "cle-storyos-manuscript-0123456789abcdef0123456789abcdef.json"
    path = _payload_path(name)
    path.write_text(
        json.dumps(
            {
                "schema": "story.manuscript-write-payload.v1",
                "path": "manuscript/S01/EP01_Test.md",
                "expected_sha256": "0" * 64,
                "content": "draft",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    payload = _consume_payload(path)

    assert payload["content"] == "draft"
    assert not path.exists()
    with pytest.raises(ManuscriptWorkingCopyError):
        _payload_path("../payload.json")
