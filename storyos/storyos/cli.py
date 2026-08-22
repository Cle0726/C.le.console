from __future__ import annotations

import argparse
import json
from pathlib import Path

from storyos.index import StoryIndex
from storyos.project import StoryProject
from storyos.state import StoryStateProjector


def main() -> None:
    parser = argparse.ArgumentParser(prog="storyos")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate", help="Validate canonical project files")
    p_validate.add_argument("project")

    p_index = sub.add_parser("index", help="Rebuild disposable SQLite/FTS index")
    p_index.add_argument("project")

    p_state = sub.add_parser("state", help="Project story state at a sequence boundary")
    p_state.add_argument("project")
    p_state.add_argument("--through", type=int, default=None)

    args = parser.parse_args()
    project = StoryProject.open(args.project)

    if args.command == "validate":
        entities = project.load_entities()
        events = project.load_events()
        errors = project.validate_references()
        result = {
            "ok": not errors,
            "entities": len(entities),
            "events": len(events),
            "errors": errors,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        raise SystemExit(0 if not errors else 2)

    if args.command == "index":
        db = Path(project.root) / ".storyos" / "index.sqlite"
        index = StoryIndex(db)
        index.rebuild(project)
        print(json.dumps({"ok": True, "db": str(db), **index.counts()}, ensure_ascii=False, indent=2))
        return

    if args.command == "state":
        states = StoryStateProjector().project(project.load_events(), through_sequence=args.through)
        payload = {
            entity_id: {
                "values": state.values,
                "knowledge": sorted(state.knowledge),
                "resolved_plots": sorted(state.resolved_plots),
            }
            for entity_id, state in states.items()
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
