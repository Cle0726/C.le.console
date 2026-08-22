from __future__ import annotations

import argparse
import json
from dataclasses import asdict
from pathlib import Path

from storyos.authority import CanonResolver
from storyos.claims import ClaimStager
from storyos.context import ContextCompiler, ContextMode, ContextRequest
from storyos.duanxian_import import DuanxianImportError, DuanxianV39Importer
from storyos.index import StoryIndex
from storyos.inspector import ContextInspector
from storyos.knowledge import KnowledgeTimeline
from storyos.project import StoryProject
from storyos.retrieval import RetrievalIndexError, SQLiteCanonicalRetriever
from storyos.state import StoryStateProjector


def _add_context_args(parser: argparse.ArgumentParser, *, inspector: bool = False) -> None:
    parser.add_argument("project")
    parser.add_argument("--through", type=int, required=True)
    parser.add_argument("--participant", action="append", default=[])
    parser.add_argument("--pov", default=None)
    parser.add_argument("--pin", action="append", default=[])
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--mode", choices=[mode.value for mode in ContextMode], default=ContextMode.POV.value)
    parser.add_argument("--query", default=None, help="Canonical lexical retrieval query")
    parser.add_argument("--semantic-limit", type=int, default=8)
    parser.add_argument(
        "--pov-state-key",
        action="append",
        default=None,
        help="Objective state key allowed into POV context; repeatable. Defaults to location.",
    )
    if inspector:
        parser.add_argument("--ref", default=None, help="Inspect one ref instead of the full trace set")


def main() -> None:
    parser = argparse.ArgumentParser(prog="storyos")
    sub = parser.add_subparsers(dest="command", required=True)

    p_import = sub.add_parser(
        "import-duanxian-v39",
        help="Import the Duanxian Season 1 v3.9 mother package into a new StoryOS project",
    )
    p_import.add_argument("source")
    p_import.add_argument("target")
    p_import.add_argument(
        "--allow-dirty-source",
        action="store_true",
        help="Allow known source hash/file-count differences and record them in the import report",
    )

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

    p_retrieve = sub.add_parser("retrieve", help="Inspect raw canonical retrieval candidates")
    p_retrieve.add_argument("project")
    p_retrieve.add_argument("query")
    p_retrieve.add_argument("--limit", type=int, default=8)

    p_context = sub.add_parser("context", help="Compile explainable deterministic model context")
    _add_context_args(p_context)

    p_inspect = sub.add_parser("context-inspect", help="Explain why context refs were included or blocked")
    _add_context_args(p_inspect, inspector=True)

    args = parser.parse_args()

    if args.command == "import-duanxian-v39":
        try:
            report = DuanxianV39Importer(args.source).apply(
                args.target,
                allow_dirty_source=args.allow_dirty_source,
            )
        except DuanxianImportError as exc:
            parser.exit(2, f"storyos: import failed: {exc}\n")
        print(json.dumps(report, ensure_ascii=False, indent=2, sort_keys=True))
        return

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

    if args.command == "retrieve":
        retriever = _ensure_retriever(project)
        hits = retriever.search(args.query, limit=args.limit)
        print(
            json.dumps(
                {
                    "schema": "story.retrieval.v1",
                    "query": args.query,
                    "limit": args.limit,
                    "hits": [
                        {"ref": hit.ref, "score": hit.score}
                        for hit in hits
                    ],
                },
                ensure_ascii=False,
                indent=2,
                sort_keys=True,
            )
        )
        return

    if args.command in {"context", "context-inspect"}:
        manifest = _compile_context(project, args)
        if args.command == "context":
            print(json.dumps(_manifest_payload(manifest), ensure_ascii=False, indent=2, sort_keys=True))
            return

        inspection = ContextInspector().inspect(manifest, ref=args.ref)
        payload = {
            "schema": "story.context-inspection.v1",
            "request": manifest.as_dict()["request"],
            **inspection,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return


def _compile_context(project: StoryProject, args) -> object:
    mode = ContextMode(args.mode)
    pov_state_keys = tuple(args.pov_state_key or ("location",))
    retriever = _ensure_retriever(project) if args.query else None
    request = ContextRequest(
        through_sequence=args.through,
        participants=tuple(args.participant),
        pov=args.pov,
        pinned=tuple(args.pin),
        semantic_query=args.query,
        semantic_limit=args.semantic_limit,
        max_chars=args.max_chars,
        mode=mode,
        pov_state_keys=pov_state_keys,
    )
    return ContextCompiler(project, retriever=retriever).compile(request)


def _ensure_retriever(project: StoryProject) -> SQLiteCanonicalRetriever:
    db = Path(project.root) / ".storyos" / "index.sqlite"
    retriever = SQLiteCanonicalRetriever(db)
    try:
        retriever.validate()
    except RetrievalIndexError:
        StoryIndex(db).rebuild(project)
        retriever = SQLiteCanonicalRetriever(db)
        retriever.validate()
    return retriever


def _manifest_payload(manifest) -> dict:
    payload = manifest.as_dict()
    request = manifest.request
    payload.update(
        {
            "through_sequence": request.through_sequence,
            "mode": request.mode.value,
            "pov": request.pov,
            "pov_state_keys": list(request.pov_state_keys),
        }
    )
    return payload


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
