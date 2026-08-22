from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from storyos.project import StoryProject


class StoryIndex:
    """Rebuildable SQLite/FTS index. Canonical files remain source of truth."""

    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)

    def rebuild(self, project: StoryProject) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        if self.db_path.exists():
            self.db_path.unlink()

        conn = sqlite3.connect(self.db_path)
        try:
            conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE entities (
                    id TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    aliases_json TEXT NOT NULL,
                    data_json TEXT NOT NULL
                );
                CREATE TABLE events (
                    id TEXT PRIMARY KEY,
                    subject TEXT NOT NULL,
                    event_type TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    season INTEGER,
                    episode INTEGER,
                    scene INTEGER,
                    payload_json TEXT NOT NULL,
                    source_json TEXT NOT NULL
                );
                CREATE INDEX idx_events_subject_sequence
                    ON events(subject, sequence);
                CREATE VIRTUAL TABLE entity_fts USING fts5(
                    id UNINDEXED,
                    name,
                    aliases,
                    data
                );
                CREATE VIRTUAL TABLE event_fts USING fts5(
                    id UNINDEXED,
                    subject,
                    event_type,
                    text
                );
                """
            )
            conn.execute("INSERT INTO meta(key, value) VALUES('schema', 'story.index.v1')")

            for entity in project.load_entities():
                aliases_json = json.dumps(entity.aliases, ensure_ascii=False)
                data_json = json.dumps(entity.data, ensure_ascii=False, sort_keys=True)
                conn.execute(
                    "INSERT INTO entities VALUES (?, ?, ?, ?, ?, ?)",
                    (entity.id, entity.kind, entity.name, entity.slug, aliases_json, data_json),
                )
                conn.execute(
                    "INSERT INTO entity_fts(id, name, aliases, data) VALUES (?, ?, ?, ?)",
                    (entity.id, entity.name, " ".join(entity.aliases), data_json),
                )

            for event in project.load_events():
                payload_json = json.dumps(event.payload, ensure_ascii=False, sort_keys=True)
                source_json = json.dumps(event.source, ensure_ascii=False, sort_keys=True)
                conn.execute(
                    """INSERT INTO events
                    (id, subject, event_type, sequence, season, episode, scene, payload_json, source_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        event.id,
                        event.subject,
                        event.type,
                        event.at.sequence,
                        event.at.season,
                        event.at.episode,
                        event.at.scene,
                        payload_json,
                        source_json,
                    ),
                )
                conn.execute(
                    "INSERT INTO event_fts(id, subject, event_type, text) VALUES (?, ?, ?, ?)",
                    (event.id, event.subject, event.type, f"{payload_json} {source_json}"),
                )
            conn.commit()
        finally:
            conn.close()

    def counts(self) -> dict[str, int]:
        with sqlite3.connect(self.db_path) as conn:
            entities = conn.execute("SELECT count(*) FROM entities").fetchone()[0]
            events = conn.execute("SELECT count(*) FROM events").fetchone()[0]
        return {"entities": int(entities), "events": int(events)}
