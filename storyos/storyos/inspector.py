from __future__ import annotations

from collections import Counter
from dataclasses import dataclass

from storyos.context import ContextManifest


@dataclass(frozen=True)
class ContextTrace:
    ref: str
    retrieval_score: float | None
    included: bool
    kind: str | None
    reasons: tuple[str, ...]
    exclusion_reasons: tuple[str, ...]
    exclusion_details: tuple[str, ...]
    priority: int | None
    required: bool
    char_count: int

    def as_dict(self) -> dict:
        return {
            "ref": self.ref,
            "retrieval_score": self.retrieval_score,
            "included": self.included,
            "kind": self.kind,
            "reasons": list(self.reasons),
            "exclusion_reasons": list(self.exclusion_reasons),
            "exclusion_details": list(self.exclusion_details),
            "priority": self.priority,
            "required": self.required,
            "char_count": self.char_count,
        }


class ContextInspector:
    """Build compact diagnostics from an immutable ContextManifest."""

    def summarize(self, manifest: ContextManifest) -> dict:
        reason_counts = Counter(item.reason for item in manifest.excluded)
        retrieved_refs = {hit.ref for hit in manifest.retrieval_hits}
        included_refs = {item.ref for item in manifest.included}
        blocked_retrievals = sorted(
            ref
            for ref in retrieved_refs
            if ref not in included_refs
        )
        max_chars = manifest.request.max_chars
        utilization = 0.0 if max_chars == 0 else manifest.used_chars / max_chars
        return {
            "through_sequence": manifest.request.through_sequence,
            "mode": manifest.request.mode.value,
            "pov": manifest.request.pov,
            "included_count": len(manifest.included),
            "excluded_count": len(manifest.excluded),
            "retrieval_hit_count": len(manifest.retrieval_hits),
            "blocked_retrieval_count": len(blocked_retrievals),
            "blocked_retrieval_refs": blocked_retrievals,
            "budget": {
                "used_chars": manifest.used_chars,
                "max_chars": max_chars,
                "utilization": round(utilization, 6),
            },
            "exclusion_reason_counts": dict(sorted(reason_counts.items())),
        }

    def trace(self, manifest: ContextManifest, ref: str) -> ContextTrace:
        retrieval_score = next(
            (hit.score for hit in manifest.retrieval_hits if hit.ref == ref),
            None,
        )
        included = next((item for item in manifest.included if item.ref == ref), None)
        exclusions = tuple(item for item in manifest.excluded if item.ref == ref)

        return ContextTrace(
            ref=ref,
            retrieval_score=retrieval_score,
            included=included is not None,
            kind=None if included is None else included.kind,
            reasons=() if included is None else included.reasons,
            exclusion_reasons=tuple(sorted({item.reason for item in exclusions})),
            exclusion_details=tuple(
                sorted({item.detail for item in exclusions if item.detail})
            ),
            priority=None if included is None else included.priority,
            required=False if included is None else included.required,
            char_count=0 if included is None else included.char_count,
        )

    def traces(self, manifest: ContextManifest) -> tuple[ContextTrace, ...]:
        refs = {
            *(item.ref for item in manifest.included),
            *(item.ref for item in manifest.excluded),
            *(hit.ref for hit in manifest.retrieval_hits),
        }
        return tuple(self.trace(manifest, ref) for ref in sorted(refs))

    def inspect(self, manifest: ContextManifest, *, ref: str | None = None) -> dict:
        payload = {"summary": self.summarize(manifest)}
        if ref is not None:
            payload["trace"] = self.trace(manifest, ref).as_dict()
        else:
            payload["traces"] = [trace.as_dict() for trace in self.traces(manifest)]
        return payload
