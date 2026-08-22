from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from storyos.project import StoryProject
from storyos.workspace import AuthoringWorkspace, AuthoringWorkspaceError


def test_manuscript_symlink_is_rejected_when_platform_supports_symlinks(tmp_path):
    root = tmp_path / "project"
    root.mkdir()
    (root / "storyos.yaml").write_text(
        yaml.safe_dump(
            {
                "schema": "story.project.v1",
                "id": "workspace-symlink-test",
                "name": "Workspace Symlink Test",
                "language": "en",
                "paths": {"manuscript": "manuscript"},
            },
            sort_keys=False,
        ),
        encoding="utf-8",
    )
    manuscript_dir = root / "manuscript" / "S01"
    manuscript_dir.mkdir(parents=True)
    outside = tmp_path / "outside.txt"
    outside.write_text("outside project data", encoding="utf-8")
    link = manuscript_dir / "EP01_Link.txt"
    try:
        link.symlink_to(outside)
    except (OSError, NotImplementedError):
        pytest.skip("symlink creation is unavailable on this runner")

    project = StoryProject.open(root)
    workspace = AuthoringWorkspace()

    with pytest.raises(AuthoringWorkspaceError, match="symlink"):
        workspace.list_manuscripts(project)
    with pytest.raises(AuthoringWorkspaceError, match="symlink"):
        workspace.load_manuscript(project, "manuscript/S01/EP01_Link.txt")
