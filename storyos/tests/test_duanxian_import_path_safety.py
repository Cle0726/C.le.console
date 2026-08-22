from pathlib import Path

import pytest

from storyos.duanxian_import import DuanxianImportError, DuanxianV39Importer


def test_target_inside_source_is_rejected_before_manifest_read(tmp_path: Path):
    source = tmp_path / "mother-package"
    source.mkdir()
    nested_target = source / "storyos-project"

    with pytest.raises(DuanxianImportError, match="outside the source mother package"):
        DuanxianV39Importer(source).apply(nested_target)

    assert not nested_target.exists()


def test_source_directory_cannot_be_used_as_target(tmp_path: Path):
    source = tmp_path / "mother-package"
    source.mkdir()

    with pytest.raises(DuanxianImportError, match="outside the source mother package"):
        DuanxianV39Importer(source).apply(source)
