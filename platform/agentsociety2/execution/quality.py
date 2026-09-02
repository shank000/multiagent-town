"""Credential-free run quality/capacity report and formal fail-closed gate."""

from __future__ import annotations

from collections import Counter
import json
from pathlib import Path
from typing import Any, Iterable, Mapping

from analysis.validate_run import validate_events


REPORT_SCHEMA = "partner-choice.quality-report/v1"


def directory_size(path: Path) -> int:
    return sum(item.stat().st_size for item in Path(path).rglob("*") if item.is_file()) if Path(path).exists() else 0


def _token_total(events: Iterable[Mapping[str, Any]], event_type: str) -> dict[str, int | None]:
    fields = ("inputTokens", "outputTokens", "totalTokens")
    sums = {field: 0 for field in fields}
    available = False
    for event in events:
        audit = event.get("decision", {}) if event_type == "partner_choice" else event.get("summaryDecision", {})
        for field in fields:
            if audit.get(field) is not None:
                sums[field] += int(audit[field])
                available = True
    return {field: (sums[field] if available else None) for field in fields}


def build_quality_report(
    protocol: Mapping[str, Any],
    events: list[Mapping[str, Any]],
    *,
    duration_ms: float,
    replay_dir: Path,
    checkpoint_dir: Path,
    sdk_token_stats: Mapping[str, Any] | None = None,
    runtime_errors: Iterable[str] = (),
) -> dict[str, Any]:
    choices = [event for event in events if event.get("eventType") == "partner_choice"]
    interactions = [event for event in events if event.get("eventType") == "interaction"]
    expected = int(protocol["days"]) * len(protocol["agentIds"])
    unique_choices = {(event.get("day"), event.get("chooserId")) for event in choices}
    unique_interactions = {(event.get("day"), event.get("fromId")) for event in interactions}
    completed_choices = min(expected, len(unique_choices))
    completed_interactions = min(expected, len(unique_interactions))
    choice_fallback = [event for event in choices if event.get("decision", {}).get("source") != "llm"]
    interaction_fallback = [event for event in interactions if event.get("summaryDecision", {}).get("source") != "llm"]
    total_expected_calls = expected * 2
    fallback_count = len(choice_fallback) + len(interaction_fallback)
    fallback_rate = fallback_count / total_expected_calls if total_expected_calls else 0.0
    errors = list(validate_events(protocol, events))
    errors.extend(str(item) for item in runtime_errors)
    if len(interactions) != expected:
        errors.append(f"run: expected {expected} completed interactions, got {len(interactions)}")
    for event in choices:
        decision = event.get("decision", {})
        if decision.get("source") == "llm" and not all(decision.get(field) for field in ("modelId", "requestId", "promptHash", "rawResponse")):
            errors.append(f"choice {event.get('eventId')}: incomplete real-model audit")
        if decision.get("fallbackReason") == "late_or_skipped_round":
            errors.append(f"choice {event.get('eventId')}: late_or_skipped_round")
    for event in interactions:
        audit = event.get("summaryDecision", {})
        if audit.get("source") == "llm" and not all(audit.get(field) for field in ("modelId", "requestId", "promptHash", "rawResponse")):
            errors.append(f"interaction {event.get('eventId')}: incomplete real-model audit")
        if audit.get("fallbackReason") == "late_or_skipped_round":
            errors.append(f"interaction {event.get('eventId')}: late_or_skipped_round")
    max_fallback = float(protocol["decision"]["maxFallbackRate"])
    if fallback_rate > max_fallback:
        errors.append(f"run: fallback rate {fallback_rate:.6f} exceeds {max_fallback:.6f}")
    ids = [str(event.get("eventId")) for event in events if event.get("eventId")]
    duplicate_count = len(ids) - len(set(ids))
    error_classes = Counter(
        "late_or_skipped" if "late_or_skipped" in error
        else "duplicate" if "duplicate" in error
        else "incomplete" if "expected" in error or "incomplete" in error
        else "fallback_rate" if "fallback rate" in error
        else "contract"
        for error in errors
    )
    checkpoint_bytes = directory_size(checkpoint_dir)
    try:
        replay_inside_checkpoint = Path(replay_dir).resolve().is_relative_to(Path(checkpoint_dir).resolve())
    except ValueError:
        replay_inside_checkpoint = False
    if replay_inside_checkpoint:
        checkpoint_bytes = max(0, checkpoint_bytes - directory_size(replay_dir))
    report = {
        "schemaVersion": REPORT_SCHEMA,
        "runId": protocol["runId"],
        "conditionId": protocol["conditionId"],
        "seed": protocol["seed"],
        "durationMs": round(float(duration_ms), 3),
        "completion": {
            "expectedChoices": expected,
            "completedChoices": completed_choices,
            "expectedInteractions": expected,
            "completedInteractions": completed_interactions,
            "rate": (completed_choices + completed_interactions) / total_expected_calls if total_expected_calls else 1.0,
        },
        "calls": {
            "choiceEvents": len(choices),
            "choiceAttempts": sum(int(event.get("decision", {}).get("attemptCount", 0)) for event in choices),
            "interactionEvents": len(interactions),
            "interactionAttempts": sum(int(event.get("summaryDecision", {}).get("attemptCount", 0)) for event in interactions),
        },
        "tokens": {
            "choices": _token_total(choices, "partner_choice"),
            "interactions": _token_total(interactions, "interaction"),
            "sdkAggregate": dict(sdk_token_stats or {}),
        },
        "fallback": {
            "choiceCount": len(choice_fallback),
            "interactionCount": len(interaction_fallback),
            "rate": fallback_rate,
            "maximum": max_fallback,
        },
        "storageBytes": {
            "replay": directory_size(replay_dir),
            "checkpoint": checkpoint_bytes,
        },
        "integrity": {
            "eventCount": len(events),
            "duplicateEventIds": duplicate_count,
            "errorCount": len(errors),
            "errorClasses": dict(sorted(error_classes.items())),
            "errors": errors,
        },
        "formalGatePassed": not errors,
    }
    return report


def write_quality_report(report: Mapping[str, Any], output: Path) -> None:
    output = Path(output)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary.replace(output)
