from pathlib import Path

from storyos.index import StoryIndex
from storyos.project import StoryProject


def demo_root() -> Path:
    return Path(__file__).parents[1] / "examples" / "demo"


def test_demo_project_validates():
    project = StoryProject.open(demo_root())
    assert len(project.load_entities()) == 2
    assert len(project.load_events()) == 1
    assert project.validate_references() == []


def test_index_is_rebuildable(tmp_path):
    project = StoryProject.open(demo_root())
    db = tmp_path / "index.sqlite"
    index = StoryIndex(db)

    index.rebuild(project)
    assert index.counts() == {"entities": 2, "events": 1}

    db.unlink()
    index.rebuild(project)
    assert index.counts() == {"entities": 2, "events": 1}
