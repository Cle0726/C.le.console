from __future__ import annotations

import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Protocol

from storyos.authority import CanonFact, CanonResolver
from storyos.knowledge import KnowledgeTimeline
from storyos.project import StoryProject
from storyos.state import StoryStateProjector


class ContextMode(str, Enum):
    AUTHOR = "author"
    POV = "pov"


@dataclass(frozen=True)
class RetrievalHit:
    ref: str
    score: float


class SemanticRetriever(Protocol):
    def search(self, query: str, *, limit: int = 8) -> Iterable[RetrievalHit]: ...


@dataclass(frozen=True)
class ContextRequest:
    through_sequence: int
    participants: tuple[str, ...] = ()
    pov: str | None = None
    pinned: tuple[str, ...] = ()
    semantic_query: str | None = None
    semantic_limit: int = 8
    max_chars: int = 12000
    mode: ContextMode = ContextMode.POV
    pov_state_keys: tuple[str, ...] = ("location",)

    def __post_init__(self) -> None:
        if not isinstance(self.mode, ContextMode):
            object.__setattr__(self, "mode", ContextMode(self.mode))
        object.__setattr__(self, "participants", tuple(self.participants))
        object.__setattr__(self, "pinned", tuple(self.pinned))
        object.__setattr__(self, "pov_state_keys", tuple(self.pov_state_keys))

    def validate(self) -> None:
        if self.through_sequence < 0:
            raise ValueError("through_sequence must be >= 0")
        if self.max_chars < 0:
            raise ValueError("max_chars must be >= 0")
        if self.semantic_limit < 0:
            raise ValueError("semantic_limit must be >= 0")
        if self.mode is ContextMode.POV and self.pov is None:
            raise ValueError("POV context mode requires pov")
        if any(not key.strip() for key in self.pov_state_keys):
            raise ValueError("pov_state_keys cannot contain empty keys")


@dataclass(frozen=True)
class ContextItem:
    ref: str
    kind: str
    content: str
    reasons: tuple[str, ...]
    priority: int
    required: bool = False

    @property
    def char_count(self) -> int:
        return len(self.content)


@dataclass(frozen=True)
class ExcludedContextItem:
    ref: str
    reason: str
    detail: str = ""


@dataclass(frozen=True)
class ContextManifest:
    through_sequence: int
    mode: ContextMode
    pov: str | None
    max_chars: int
    pov_state_keys: tuple[str, ...]
    included: tuple[ContextItem, ...]
    excluded: tuple[ExcludedContextItem, ...]

    @property
    def used_chars(self) -> int:
        return sum(item.char_count for item in self.included)

    def render(self) -> str:
        """Render only included content for a model prompt."""
        return "\n\n".join(item.content for item in self.included)

    def as_dict(self) -> dict:
        return {
            "schema": "story.context.v1",
            "through_sequence": self.through_sequence,
            "mode": self.mode.value,
            "pov": self.pov,
            "pov_state_keys": list(self.pov_state_keys),
            "budget": {"max_chars": self.max_chars, "used_chars": self.used_chars},
            "included": [
                {
                    "ref": item.ref,
                    "kind": item.kind,
                    "reasons": list(item.reasons),
                    "priority": item.priority,
                    "required": item.required,
                    "char_count": item.char_count,
                    "content": item.content,
                }
                for item in self.included
            ],
            "excluded": [
                {"ref": item.ref, "reason": item.reason, "detail": item.detail}
                for item in self.excluded
            ],
        }


@dataclass
class _Candidate:
    ref: str
    priority: int
    required: bool = False
    reasons: set[str] = field(default_factory=set)


class ContextCompiler:
    """Compile deterministic, explainable model context from StoryOS source data.

    Semantic retrieval is only a candidate source. It cannot bypass Canon authority,
    story time, reveal timing, POV knowledge, or scene-bound entity visibility gates.
    """

    def __init__(
        self,
        project: StoryProject,
        *,
        retriever: SemanticRetriever | None = None,
        dependencies: Mapping[str, Iterable[str]] | None = None,
    ) -> None:
        self.project = project
        self.retriever = retriever
        self.dependencies = {
            ref: tuple(values)
            for ref, values in (dependencies or {}).items()
        }
        self._canon_resolver = CanonResolver()

    def compile(self, request: ContextRequest) -> ContextManifest:
        request.validate()
        entities = {entity.id: entity for entity in self.project.load_entities()}
        facts = {fact.id: fact for fact in self.project.load_canon_facts()}
        events = self.project.load_events()
        states = StoryStateProjector().project(events, through_sequence=request.through_sequence)
        knowledge = KnowledgeTimeline(events)

        excluded: list[ExcludedContextItem] = []
        candidates: dict[str, _Candidate] = {}

        def add(ref: str, reason: str, priority: int, *, required: bool = False) -> None:
            current = candidates.get(ref)
            if current is None:
                current = _Candidate(ref=ref, priority=priority, required=required)
                candidates[ref] = current
            current.priority = max(current.priority, priority)
            current.required = current.required or required
            current.reasons.add(reason)

        # Scene participants are mandatory identity/state context.
        for entity_id in request.participants:
            if entity_id not in entities:
                excluded.append(ExcludedContextItem(entity_id, "unknown_participant"))
                continue
            add(entity_id, "scene_participant", 1000, required=True)
            add(_state_ref(entity_id, request.through_sequence), "participant_state", 950, required=True)

        # POV identity/state is mandatory even when not listed as a participant.
        if request.pov is not None:
            if request.pov not in entities:
                excluded.append(ExcludedContextItem(request.pov, "unknown_pov"))
            else:
                add(request.pov, "pov", 1100, required=True)
                add(_state_ref(request.pov, request.through_sequence), "pov_state", 1050, required=True)

        # In POV mode, arbitrary entity/state retrieval is conservative by default.
        # Besides explicit participants/POV, an entity is scene-bound when POV-safe
        # current state directly references its stable ID (e.g. the current location).
        pov_bound_entities = _pov_bound_entities(
            request=request,
            states=states,
            known_entity_ids=set(entities),
        )

        # Manual pins are strong candidates, but still pass all safety gates.
        for ref in request.pinned:
            add(ref, "manual_pin", 900)

        # Canon facts directly about current participants/P.O.V. become deterministic candidates.
        relevant_subjects = set(request.participants)
        if request.pov is not None:
            relevant_subjects.add(request.pov)
        grouped: dict[tuple[str, str], list[CanonFact]] = {}
        for fact in facts.values():
            if fact.subject in relevant_subjects:
                grouped.setdefault((fact.subject, fact.predicate), []).append(fact)

        for (subject, predicate), group in grouped.items():
            resolution = self._canon_resolver.resolve(
                group,
                subject=subject,
                predicate=predicate,
                through_sequence=request.through_sequence,
            )
            if resolution.ambiguous:
                for fact in resolution.conflicts:
                    excluded.append(ExcludedContextItem(fact.id, "canon_ambiguous"))
                continue
            if resolution.fact is not None:
                add(resolution.fact.id, "participant_canon", 700)

        # Semantic search contributes candidates only; no direct inclusion is possible.
        if request.semantic_query and self.retriever is not None:
            for hit in self.retriever.search(request.semantic_query, limit=request.semantic_limit):
                score = max(0.0, min(1.0, float(hit.score)))
                add(hit.ref, "semantic_retrieval", 500 + int(score * 100))

        safe_items: list[ContextItem] = []
        processed: set[str] = set()
        queue = sorted(candidates.values(), key=_candidate_sort_key)

        while queue:
            candidate = queue.pop(0)
            if candidate.ref in processed:
                continue
            processed.add(candidate.ref)

            item, rejection = self._materialize_candidate(
                candidate,
                request=request,
                entities=entities,
                facts=facts,
                states=states,
                knowledge=knowledge,
                pov_bound_entities=pov_bound_entities,
            )
            if rejection is not None:
                excluded.append(rejection)
                continue
            assert item is not None
            safe_items.append(item)

            # Recursive dependencies are activated only by an already-safe parent.
            for dependency in self.dependencies.get(candidate.ref, ()):
                if dependency in processed:
                    continue
                current = candidates.get(dependency)
                if current is None:
                    current = _Candidate(
                        ref=dependency,
                        priority=max(100, candidate.priority - 50),
                        required=False,
                    )
                    candidates[dependency] = current
                current.reasons.add(f"dependency_of:{candidate.ref}")
                current.priority = max(current.priority, max(100, candidate.priority - 50))
                queue.append(current)
            queue.sort(key=_candidate_sort_key)

        # Required items are never removed by the soft character budget. Optional items are.
        included: list[ContextItem] = []
        used = 0
        for item in sorted(safe_items, key=_item_sort_key):
            if item.required:
                included.append(item)
                used += item.char_count
                continue
            if used + item.char_count > request.max_chars:
                excluded.append(
                    ExcludedContextItem(
                        item.ref,
                        "budget",
                        f"would exceed max_chars={request.max_chars}",
                    )
                )
                continue
            included.append(item)
            used += item.char_count

        return ContextManifest(
            through_sequence=request.through_sequence,
            mode=request.mode,
            pov=request.pov,
            max_chars=request.max_chars,
            pov_state_keys=request.pov_state_keys,
            included=tuple(included),
            excluded=tuple(_dedupe_excluded(excluded)),
        )

    def _materialize_candidate(
        self,
        candidate: _Candidate,
        *,
        request: ContextRequest,
        entities: Mapping[str, object],
        facts: Mapping[str, CanonFact],
        states: Mapping[str, object],
        knowledge: KnowledgeTimeline,
        pov_bound_entities: set[str],
    ) -> tuple[ContextItem | None, ExcludedContextItem | None]:
        ref = candidate.ref
        if ref.startswith("state:"):
            entity_id = _parse_state_ref(ref)
            if entity_id is None or entity_id not in entities:
                return None, ExcludedContextItem(ref, "unknown_state_ref")
            if request.mode is ContextMode.POV and entity_id not in pov_bound_entities:
                return None, ExcludedContextItem(ref, "pov_state_unbound")
            state = states.get(entity_id)
            objective_values = {} if state is None else state.values
            values = _context_state_values(objective_values, request)
            content = json.dumps(
                {"type": "state", "entity": entity_id, "through": request.through_sequence, "values": values},
                ensure_ascii=False,
                sort_keys=True,
            )
            return ContextItem(
                ref=ref,
                kind="state",
                content=content,
                reasons=tuple(sorted(candidate.reasons)),
                priority=candidate.priority,
                required=candidate.required,
            ), None

        entity = entities.get(ref)
        if entity is not None:
            if request.mode is ContextMode.POV and ref not in pov_bound_entities:
                return None, ExcludedContextItem(ref, "pov_entity_unbound")
            # Arbitrary entity.data is intentionally not injected here; it may contain hidden author notes.
            content = json.dumps(
                {
                    "type": "entity",
                    "id": entity.id,
                    "kind": entity.kind,
                    "name": entity.name,
                    "slug": entity.slug,
                    "aliases": list(entity.aliases),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            return ContextItem(
                ref=ref,
                kind="entity",
                content=content,
                reasons=tuple(sorted(candidate.reasons)),
                priority=candidate.priority,
                required=candidate.required,
            ), None

        fact = facts.get(ref)
        if fact is not None:
            if not fact.active_at(request.through_sequence):
                return None, ExcludedContextItem(ref, "timeline_inactive")

            resolution = self._canon_resolver.resolve(
                facts.values(),
                subject=fact.subject,
                predicate=fact.predicate,
                through_sequence=request.through_sequence,
            )
            if resolution.ambiguous:
                return None, ExcludedContextItem(ref, "canon_ambiguous")
            if resolution.fact is None:
                return None, ExcludedContextItem(ref, "canon_unresolved")
            if resolution.fact.id != fact.id:
                return None, ExcludedContextItem(
                    ref,
                    "shadowed_by_authority",
                    f"resolved={resolution.fact.id}",
                )

            if request.mode is ContextMode.POV:
                if not fact.revealed_at(request.through_sequence):
                    return None, ExcludedContextItem(ref, "not_revealed")
                is_public = "public" in fact.tags
                is_known = request.pov is not None and knowledge.knows(
                    request.pov,
                    fact.id,
                    through_sequence=request.through_sequence,
                )
                if not is_public and not is_known:
                    return None, ExcludedContextItem(ref, "pov_unknown")

            content = json.dumps(
                {
                    "type": "canon",
                    "id": fact.id,
                    "subject": fact.subject,
                    "predicate": fact.predicate,
                    "value": fact.value,
                    "authority": fact.authority.name.lower(),
                },
                ensure_ascii=False,
                sort_keys=True,
            )
            return ContextItem(
                ref=ref,
                kind="canon",
                content=content,
                reasons=tuple(sorted(candidate.reasons)),
                priority=candidate.priority,
                required=candidate.required,
            ), None

        return None, ExcludedContextItem(ref, "unknown_ref")


def _context_state_values(values: Mapping[str, Any], request: ContextRequest) -> dict[str, Any]:
    if request.mode is ContextMode.AUTHOR:
        return dict(values)
    allowed = set(request.pov_state_keys)
    return {key: value for key, value in values.items() if key in allowed}


def _pov_bound_entities(
    *,
    request: ContextRequest,
    states: Mapping[str, object],
    known_entity_ids: set[str],
) -> set[str]:
    if request.mode is not ContextMode.POV:
        return set(known_entity_ids)

    bound = {entity_id for entity_id in request.participants if entity_id in known_entity_ids}
    if request.pov in known_entity_ids:
        bound.add(request.pov)

    for entity_id in tuple(bound):
        state = states.get(entity_id)
        if state is None:
            continue
        visible_values = _context_state_values(state.values, request)
        for value in visible_values.values():
            bound.update(_extract_entity_refs(value, known_entity_ids))
    return bound


def _extract_entity_refs(value: Any, known_entity_ids: set[str]) -> set[str]:
    refs: set[str] = set()
    if isinstance(value, str):
        if value in known_entity_ids:
            refs.add(value)
        return refs
    if isinstance(value, Mapping):
        for child in value.values():
            refs.update(_extract_entity_refs(child, known_entity_ids))
        return refs
    if isinstance(value, (list, tuple, set, frozenset)):
        for child in value:
            refs.update(_extract_entity_refs(child, known_entity_ids))
    return refs


def _state_ref(entity_id: str, sequence: int) -> str:
    return f"state:{entity_id}@{sequence}"


def _parse_state_ref(ref: str) -> str | None:
    if not ref.startswith("state:") or "@" not in ref:
        return None
    return ref[len("state:"):].rsplit("@", 1)[0]


def _candidate_sort_key(candidate: _Candidate):
    return (-int(candidate.required), -candidate.priority, candidate.ref)


def _item_sort_key(item: ContextItem):
    kind_rank = {"entity": 0, "state": 1, "canon": 2}.get(item.kind, 9)
    return (-int(item.required), -item.priority, kind_rank, item.ref)


def _dedupe_excluded(items: Iterable[ExcludedContextItem]) -> list[ExcludedContextItem]:
    seen: set[tuple[str, str, str]] = set()
    result: list[ExcludedContextItem] = []
    for item in items:
        key = (item.ref, item.reason, item.detail)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return sorted(result, key=lambda item: (item.ref, item.reason, item.detail))
