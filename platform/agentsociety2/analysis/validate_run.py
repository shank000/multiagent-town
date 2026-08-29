"""Validate one AgentSociety partner-choice run before statistical analysis."""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
from typing import Any, Mapping

from custom.partner_choice_core import (
    EVENT_SCHEMA_VERSION,
    OBSERVATION_SCHEMA_VERSION,
    candidate_order,
    fallback_choice,
    protocol_hash,
    tagged_hash,
    validate_protocol,
)


EVENT_TYPES = ("partner_choice", "gift", "interaction", "relationship_state")


def reconstructed_observation(event: Mapping[str, Any]) -> dict[str, Any]:
    visible = event.get("visibleHistory") or {}
    return {
        "schemaVersion": OBSERVATION_SCHEMA_VERSION,
        "day": event["day"],
        "roundId": event["roundId"],
        "chooserId": event["chooserId"],
        "candidates": [
            {
                "id": candidate["id"],
                "name": candidate["name"],
                "history": visible.get(candidate["id"], []),
            }
            for candidate in event["preChoiceCandidates"]
        ],
    }


def validate_events(
    protocol: Mapping[str, Any],
    events: list[Mapping[str, Any]],
    *,
    require_complete: bool = True,
) -> list[str]:
    """Return all contract violations without stopping at the first malformed row."""

    errors: list[str] = []
    try:
        validate_protocol(protocol)
    except Exception as exc:
        return [f"protocol: {exc}"]

    agent_ids = list(protocol["agentIds"])
    n = len(agent_ids)
    expected_hash = protocol_hash(protocol)
    by_type: dict[str, list[Mapping[str, Any]]] = defaultdict(list)
    event_ids: list[str] = []
    for index, event in enumerate(events):
        prefix = f"event[{index}]"
        event_type = str(event.get("eventType", ""))
        if event_type not in EVENT_TYPES:
            errors.append(f"{prefix}: unsupported eventType={event_type!r}")
            continue
        by_type[event_type].append(event)
        event_id = event.get("eventId")
        if not isinstance(event_id, str) or not event_id:
            errors.append(f"{prefix}: eventId is required")
        else:
            event_ids.append(event_id)
        if event.get("schemaVersion") != EVENT_SCHEMA_VERSION:
            errors.append(f"{prefix}: schemaVersion mismatch")
        if event.get("runId") != protocol["runId"]:
            errors.append(f"{prefix}: runId mismatch")
        if event.get("conditionId") != protocol["conditionId"]:
            errors.append(f"{prefix}: conditionId mismatch")
        if event.get("pairingBlockId") != protocol["pairingBlockId"]:
            errors.append(f"{prefix}: pairingBlockId mismatch")
        if event.get("profileSetHash") != protocol["profileSetHash"]:
            errors.append(f"{prefix}: profileSetHash mismatch")
        if event.get("replicate") != protocol["replicate"] or event.get("seed") != protocol["seed"]:
            errors.append(f"{prefix}: replicate/seed mismatch")
        if event.get("protocolHash") != expected_hash:
            errors.append(f"{prefix}: protocolHash mismatch")

    duplicates = sorted(event_id for event_id, count in Counter(event_ids).items() if count > 1)
    if duplicates:
        errors.append(f"duplicate eventId values: {duplicates[:5]}")

    choices_by_round: dict[tuple[int, str], list[Mapping[str, Any]]] = defaultdict(list)
    for event in by_type["partner_choice"]:
        day = event.get("day")
        round_id = event.get("roundId")
        chooser = event.get("chooserId")
        key = (day, round_id)
        choices_by_round[key].append(event)
        prefix = f"choice[{day}/{round_id}/{chooser}]"
        if not isinstance(day, int) or not 1 <= day <= int(protocol["days"]):
            errors.append(f"{prefix}: day outside protocol")
            continue
        if chooser not in agent_ids:
            errors.append(f"{prefix}: chooser is not a participant")
            continue
        expected_candidates = candidate_order(protocol, day, chooser)
        if event.get("candidateIds") != expected_candidates:
            errors.append(f"{prefix}: candidateIds/order mismatch")
        if event.get("chosenId") not in expected_candidates:
            errors.append(f"{prefix}: chosenId is outside candidateIds")
        audit = event.get("preChoiceCandidates")
        if not isinstance(audit, list) or [item.get("id") for item in audit] != expected_candidates:
            errors.append(f"{prefix}: preChoiceCandidates mismatch")
        mode = protocol["manipulation"]["historyMode"]
        if event.get("historyMode") != mode:
            errors.append(f"{prefix}: historyMode mismatch")
        visible = event.get("visibleHistory")
        if not isinstance(visible, dict):
            errors.append(f"{prefix}: visibleHistory must be an object")
            visible = {}
        if mode == "none" and visible:
            errors.append(f"{prefix}: none condition leaked history")
        if mode != "none" and set(visible) != set(expected_candidates):
            errors.append(f"{prefix}: memory condition must audit every candidate history")
        if mode == "recent_k":
            recent_k = int(protocol["manipulation"]["recentK"])
            if any(not isinstance(records, list) or len(records) > recent_k for records in visible.values()):
                errors.append(f"{prefix}: visible history exceeds recentK")
        expected_legacy = {
            "kind": "experiment_pair_choice",
            "mode": "off" if mode == "none" else "on",
            "chosen": event.get("chosenId"),
            "fromId": chooser,
            "toId": event.get("chosenId"),
        }
        for field, expected in expected_legacy.items():
            if event.get(field) != expected:
                errors.append(f"{prefix}: legacy {field} mismatch")
        decision = event.get("decision")
        if not isinstance(decision, dict):
            errors.append(f"{prefix}: decision audit is required")
        else:
            try:
                observation_hash = tagged_hash(reconstructed_observation(event))
            except Exception as exc:
                errors.append(f"{prefix}: observation cannot be reconstructed: {exc}")
            else:
                if decision.get("observationHash") != observation_hash:
                    errors.append(f"{prefix}: observationHash mismatch")
            if decision.get("source") not in {"llm", "seeded_fallback"}:
                errors.append(f"{prefix}: unaudited decision source")
            elif decision.get("source") == "llm":
                configured_model = protocol["decision"]["modelId"]
                if configured_model == "ONLINE_WORKSPACE_REQUIRED":
                    errors.append(f"{prefix}: protocol must freeze the actual modelId")
                if decision.get("modelId") != configured_model:
                    errors.append(f"{prefix}: modelId mismatch")
                if not decision.get("requestId"):
                    errors.append(f"{prefix}: requestId is required for LLM choices")
                if not str(decision.get("promptHash", "")).startswith("sha256:"):
                    errors.append(f"{prefix}: rendered prompt hash is required")
                if decision.get("temperature") != protocol["decision"]["temperature"]:
                    errors.append(f"{prefix}: temperature mismatch")
                if decision.get("topP") != protocol["decision"]["topP"]:
                    errors.append(f"{prefix}: topP mismatch")
                if decision.get("maxTokens") != protocol["decision"]["maxTokens"]:
                    errors.append(f"{prefix}: maxTokens mismatch")
                raw_response = decision.get("rawResponse")
                try:
                    parsed_raw = json.loads(raw_response) if isinstance(raw_response, str) else None
                except json.JSONDecodeError:
                    parsed_raw = None
                if not isinstance(parsed_raw, dict) or str(parsed_raw.get("chosenId")) != event.get("chosenId"):
                    errors.append(f"{prefix}: rawResponse does not parse to chosenId")
            else:
                if event.get("chosenId") != fallback_choice(protocol, int(day), str(chooser)):
                    errors.append(f"{prefix}: seeded fallback choice mismatch")
                if decision.get("fallbackReason") == "late_or_skipped_round":
                    errors.append(f"{prefix}: skipped rounds are not confirmatory data")

    for key, round_choices in choices_by_round.items():
        choosers = [event.get("chooserId") for event in round_choices]
        if len(round_choices) != n:
            errors.append(f"round {key}: expected {n} choices, got {len(round_choices)}")
        if len(set(choosers)) != len(choosers):
            errors.append(f"round {key}: duplicate chooser submission")
        if set(choosers) != set(agent_ids):
            errors.append(f"round {key}: chooser set mismatch")

    for event_type in ("gift", "interaction", "relationship_state"):
        for event in by_type[event_type]:
            key = (event.get("day"), event.get("roundId"))
            choice_sequences = [int(choice["eventSeq"]) for choice in choices_by_round.get(key, [])]
            if choice_sequences and int(event.get("eventSeq", -1)) <= max(choice_sequences):
                errors.append(f"{event_type}[{event.get('eventId')}]: event precedes a choice in its round")

    if require_complete:
        expected_rounds = int(protocol["days"])
        if len(choices_by_round) != expected_rounds:
            errors.append(f"run: expected {expected_rounds} rounds, got {len(choices_by_round)}")
        expected_choices = expected_rounds * n
        if len(by_type["partner_choice"]) != expected_choices:
            errors.append(
                f"run: expected {expected_choices} choice events, got {len(by_type['partner_choice'])}"
            )
        expected_gifts = expected_choices if protocol["manipulation"]["giftExchange"] else 0
        if len(by_type["gift"]) != expected_gifts:
            errors.append(f"run: expected {expected_gifts} gift events, got {len(by_type['gift'])}")
        if len(by_type["interaction"]) != expected_choices:
            errors.append(
                f"run: expected {expected_choices} interaction events, got {len(by_type['interaction'])}"
            )
        expected_relationships = expected_rounds * n * (n - 1)
        if len(by_type["relationship_state"]) != expected_relationships:
            errors.append(
                "run: expected "
                f"{expected_relationships} relationship snapshots, got {len(by_type['relationship_state'])}"
            )
        fallback_count = sum(
            (event.get("decision") or {}).get("source") == "seeded_fallback"
            for event in by_type["partner_choice"]
        )
        fallback_rate = fallback_count / expected_choices if expected_choices else 0.0
        if fallback_rate > float(protocol["decision"]["maxFallbackRate"]):
            errors.append(
                f"run: fallback rate {fallback_rate:.4f} exceeds "
                f"{float(protocol['decision']['maxFallbackRate']):.4f}"
            )

        expected_round_keys = {
            (day, f"day-{day:03d}-{int(protocol['roundMinute']) // 60:02d}{int(protocol['roundMinute']) % 60:02d}")
            for day in range(1, expected_rounds + 1)
        }
        if set(choices_by_round) != expected_round_keys:
            errors.append("run: day/roundId schedule mismatch")

    sequences = sorted(
        int(event["eventSeq"])
        for rows in by_type.values()
        for event in rows
        if isinstance(event.get("eventSeq"), int)
    )
    if sequences and sequences != list(range(1, len(sequences) + 1)):
        errors.append("run: eventSeq must be contiguous from 1")
    return errors


def _payload(row: Mapping[str, Any]) -> Mapping[str, Any]:
    value = row["payload"]
    return json.loads(value) if isinstance(value, str) else value


def load_replay_events(replay_dir: Path) -> list[Mapping[str, Any]]:
    from agentsociety2.storage import ReplayReader

    reader = ReplayReader(replay_dir)
    try:
        events: list[Mapping[str, Any]] = []
        for dataset_id in (
            "partner_choice.choice_event",
            "partner_choice.gift_event",
            "partner_choice.interaction_event",
            "partner_choice.relationship_state",
        ):
            dataset = reader.get_dataset_by_id(dataset_id)
            rows = reader.fetch_dataset_rows(dataset)["rows"]
            events.extend(_payload(row) for row in rows)
        return events
    finally:
        reader.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--protocol", type=Path, required=True)
    parser.add_argument("--replay-dir", type=Path, required=True)
    parser.add_argument("--allow-incomplete", action="store_true")
    args = parser.parse_args()
    protocol = json.loads(args.protocol.read_text(encoding="utf-8"))
    events = load_replay_events(args.replay_dir)
    errors = validate_events(protocol, events, require_complete=not args.allow_incomplete)
    result = {
        "ok": not errors,
        "runId": protocol.get("runId"),
        "eventCount": len(events),
        "errorCount": len(errors),
        "errors": errors,
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if errors:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
