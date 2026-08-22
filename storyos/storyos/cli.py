from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from storyos.authority import CanonResolver
from storyos.claims import ClaimStager
from storyos.context import ContextCompiler, ContextMode, ContextRequest
from storyos.index import StoryIndex
from storyos.knowledge import KnowledgeTimeline
from storyos.project import StoryProject
from storyos.state import StoryStateProjector


def main() -> None:
    parser = argparse.ArgumentParser(prog="storyos")
    sub = parser.add_subparsers(dest="command", required=True)

    p_validate = sub.add_parser("validate", help="Validate canonical and staging project files")
    p_validate.add_argument("project")

    p_index = sub.add_parser("index", help="Rebuild disposable SQLite/FTS index")
    p_index.add_argument("project")

    p_state = sub.add_parser("state", help="Project story state at a sequence boundary")
    p_state.add_argument("project")
    p_state.add_argument("--through", type=int, default=None)

    p_canon = sub.add_parser("canon", help="Resolve one canon predicate by authority and timeline")
    p_canon.add_argument("project")
    p_canon.add_argument("subject")
    p_canon.add_argument("predicate")
    p_canon.add_argument("--through", type=int, default=None)

    p_knowledge = sub.add_parser("knowledge", help="Show what one entity knows at a sequence boundary")
    p_knowledge.add_argument("project")
    p_knowledge.add_argument("entity")
    p_knowledge.add_argument("--through", type=int, default=None)

    p_claims = sub.add_parser("claims", help="Check staged claims without modifying Canon")
    p_claims.add_argument("project")
    p_claims.add_argument("--id", dest="claim_id", default=None)

    p_context = sub.add_parser("context", help="Compile explainable deterministic model context")
    p_context.add_argument("project")
    p_context.add_argument("--through", type=int, required=True)
    p_context.add_argument("--participant", action="append", default=[])
    p_context.add_argument("--pov", default=None)
    p_context.add_argument("--pin", action="append", default=[])
    p_context.add_argument("--max-chars", type=int, default=12000)
    p_context.add_argument("--mode", choices=[mode.value for mode in ContextMode], default=ContextMode.POV.value)

    args = parser.parse_args()
    project = StoryProject.open(args.project)

    if args.command == "validate":
        entities = project.load_entities()
        events = project.load_events()
        facts = project.load_canon_facts()
        claims = project.load_claims()
        errors = project.validate_references()
        result = {
            "ok": not errors,
            "entities": len(entities),
            "events": len(events),
            "canon_facts": len(facts),
            "staged_claims": len(claims),
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
        return

    if args.command == "canon":
        resolution = CanonResolver().resolve(
            project.load_canon_facts(),
            subject=args.subject,
            predicate=args.predicate,
            through_sequence=args.through,
        )
        if resolution.ambiguous:
            payload = {
                "ok": False,
                "ambiguous": True,
                "conflicts": [_fact_payload(fact) for fact in resolution.conflicts],
            }
        else:
            payload = {
                "ok": True,
                "ambiguous": False,
                "fact": None if resolution.fact is None else _fact_payload(resolution.fact),
            }
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return

    if args.command == "knowledge":
        facts = KnowledgeTimeline(project.load_events()).known_facts(
            args.entity,
            through_sequence=args.through,
        )
        print(
            json.dumps(
                {"entity": args.entity, "through": args.through, "facts": sorted(facts)},
                ensure_ascii=False,
                indent=2,
            )
        )
        return

    if args.command == "claims":
        checker = ClaimStager()
        canon = project.load_canon_facts()
        events = project.load_events()
        claims = project.load_claims()
        if args.claim_id is not None:
            claims = [claim for claim in claims if claim.id == args.claim_id]
            if not claims:
                raise SystemExit(f"unknown claim id: {args.claim_id}")
        results = []
        for claim in claims:
            result = checker.check(claim, canon_facts=canon, events=events)
            results.append(
                {
                    "claim_id": result.claim_id,
                    "can_approve": result.can_approve,
                    "duplicate_of": result.duplicate_of,
                    "issues": [asdict(issue) for issue in result.issues],
                }
            )
        print(json.dumps({"claims": results}, ensure_ascii=False, indent=2, sort_keys=True))
        return

    if args.command == "context":
        mode = ContextMode(args.mode)
        request = ContextRequest(
            through_sequence=args.through,
            participants=tuple(args.participant),
            pov=args.pov,
            pinned=tuple(args.pin),
            max_chars=args.max_chars,
            mode=mode,
        )
        manifest = ContextCompiler(project).compile(request)
        print(json.dumps(manifest.as_dict(), ensure_ascii=False, indent=2, sort_keys=True))
        return


def _fact_payload(fact):
    return {
        "id": fact.id,
        "subject": fact.subject,
        "predicate": fact.predicate,
        "value": fact.value,
        "authority": fact.authority.name.lower(),
        "valid_from": fact.valid_from,
        "valid_to": fact.valid_to,
        "reveal_at": fact.reveal_at,
    }
