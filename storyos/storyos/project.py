from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

import yaml

from storyos.entities import StoryEntity
from storyos.events import StoryEvent


@dataclass(frozen=True)
class StoryProject:
    root: Path
    manifest: dict[str, Any]

    @classmethod
    def open(cls, root: str | Path) -> "StoryProject":
        root_path = Path(root).resolve()
        manifest_path = root_path / "storyos.yaml"
        if not manifest_path.is_file():
            raise FileNotFoundError(f"missing project manifest: {manifest_path}")
        with manifest_path.open("r", encoding="utf-8") as fh:
            manifest = yaml.safe_load(fh) or {}
        if manifest.get("schema") != "story.project.v1":
            raise ValueError("unsupported or missing story.project.v1 manifest")
        return cls(root=root_path, manifest=manifest)

    def iter_event_files(self) -> Iterable[Path]:
        return _iter_data_files(self.root / "events")

    def iter_entity_files(self) -> Iterable[Path]:
        return _iter_data_files(self.root / "entities")

    def load_events(self) -> list[StoryEvent]:
        events: list[StoryEvent] = []
        seen_ids: set[str] = set()
        for path in self.iter_event_files():
            data = _load_data(path)
            records = data if isinstance(data, list) else [data]
            for raw in records:
                if not isinstance(raw, dict):
                    raise ValueError(f"event record must be an object: {path}")
                if raw.get("schema") not in (None, "story.event.v1"):
                    raise ValueError(f"unsupported event schema in {path}")
                raw = dict(raw)
                raw.pop("schema", None)
                event = StoryEvent.from_mapping(raw)
                if event.id in seen_ids:
                    raise ValueError(f"duplicate event id: {event.id}")
                seen_ids.add(event.id)
                events.append(event)
        return events

    def load_entities(self) -> list[StoryEntity]:
        entities: list[StoryEntity] = []
        seen_ids: set[str] = set()
        for path in self.iter_entity_files():
            data = _load_data(path)
            records = data if isinstance(data, list) else [data]
            for raw in records:
                if not isinstance(raw, dict):
                    raise ValueError(f"entity record must be an object: {path}")
                if raw.get("schema") not in (None, "story.entity.v1"):
                    raise ValueError(f"unsupported entity schema in {path}")
                raw = dict(raw)
                raw.pop("schema", None)
                entity = StoryEntity.from_mapping(raw)
                if entity.id in seen_ids:
                    raise ValueError(f"duplicate entity id: {entity.id}")
                seen_ids.add(entity.id)
                entities.append(entity)
        return entities

    def validate_references(self) -> list[str]:
        entity_ids = {entity.id for entity in self.load_entities()}
        errors: list[str] = []
        for event in self.load_events():
            if event.subject not in entity_ids:
                errors.append(f"event {event.id} references missing subject {event.subject}")
        return errors


def _iter_data_files(directory: Path) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(
        p for p in directory.rglob("*")
        if p.is_file() and p.suffix.lower() in {".yaml", ".yml", ".json"}
    )


def _load_data(path: Path):
    with path.open("r", encoding="utf-8") as fh:
        if path.suffix.lower() == ".json":
            return json.load(fh)
        return yaml.safe_load(fh)
