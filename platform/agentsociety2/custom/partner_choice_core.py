"""Dependency-free partner-choice protocol core shared by the AgentSociety² adapter.

The core owns treatment isolation, labelled randomness, event ordering, and
checkpointable dynamic state. It intentionally does not call an LLM; every
condition reaches it through the same observe/submit tool chain.
"""

from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta
from hashlib import sha256
import json
import math
from typing import Any, Mapping


PROTOCOL_SCHEMA_VERSION = "partner-choice.protocol/v1"
OBSERVATION_SCHEMA_VERSION = "partner-choice.observation/v1"
EVENT_SCHEMA_VERSION = "partner-choice.event/v1"
STATE_SCHEMA_VERSION = "partner-choice.state/v1"


class ContractError(ValueError):
    """Raised when a protocol or action violates a study invariant."""


def canonical_json(value: Any) -> str:
    """Return the recursive key-sorted UTF-8 JSON representation used by TS."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def tagged_hash(value: Any) -> str:
    return "sha256:" + sha256(canonical_json(value).encode("utf-8")).hexdigest()


def deterministic_id(*parts: Any) -> str:
    return sha256(canonical_json(list(parts)).encode("utf-8")).hexdigest()


def validate_protocol(protocol: Mapping[str, Any]) -> None:
    if protocol.get("schemaVersion") != PROTOCOL_SCHEMA_VERSION:
        raise ContractError(f"schemaVersion must be {PROTOCOL_SCHEMA_VERSION}")
    agent_ids = protocol.get("agentIds")
    if not isinstance(agent_ids, list) or len(agent_ids) < 2:
        raise ContractError("agentIds must contain at least two participants")
    if any(not isinstance(agent_id, str) or not agent_id for agent_id in agent_ids):
        raise ContractError("agentIds must be non-empty strings")
    if len(set(agent_ids)) != len(agent_ids):
        raise ContractError("agentIds must be unique")
    if not isinstance(protocol.get("seed"), int) or protocol["seed"] <= 0:
        raise ContractError("seed must be a positive integer")
    if not isinstance(protocol.get("days"), int) or protocol["days"] <= 0:
        raise ContractError("days must be a positive integer")
    round_minute = protocol.get("roundMinute")
    if not isinstance(round_minute, int) or not 0 <= round_minute < 1440:
        raise ContractError("roundMinute must be within one day")
    manipulation = protocol.get("manipulation")
    if not isinstance(manipulation, Mapping):
        raise ContractError("manipulation is required")
    mode = manipulation.get("historyMode")
    if mode not in {"none", "recent_k", "full"}:
        raise ContractError("historyMode must be none, recent_k, or full")
    recent_k = manipulation.get("recentK")
    if mode == "recent_k" and (not isinstance(recent_k, int) or recent_k <= 0):
        raise ContractError("recent_k requires a positive recentK")
    if mode != "recent_k" and recent_k is not None:
        raise ContractError("recentK is valid only for recent_k")
    decision = protocol.get("decision")
    if not isinstance(decision, Mapping) or decision.get("policy") != "llm":
        raise ContractError("all confirmatory conditions must use policy=llm")
    if decision.get("fallback") != "seeded_uniform":
        raise ContractError("fallback must be seeded_uniform")
    if decision.get("contextPolicy") != "observation_only_fresh_completion":
        raise ContractError("contextPolicy must be observation_only_fresh_completion")
    if not isinstance(decision.get("modelId"), str) or not decision["modelId"]:
        raise ContractError("modelId is required")
    max_fallback_rate = decision.get("maxFallbackRate")
    if not isinstance(max_fallback_rate, (int, float)) or not 0 <= max_fallback_rate <= 1:
        raise ContractError("maxFallbackRate must be within [0, 1]")


def protocol_hash(protocol: Mapping[str, Any]) -> str:
    validate_protocol(protocol)
    return tagged_hash(protocol)


def candidate_order(protocol: Mapping[str, Any], day: int, chooser_id: str) -> list[str]:
    """Paired labelled ordering, byte-compatible with the TypeScript contract."""

    validate_protocol(protocol)
    agent_ids = list(protocol["agentIds"])
    if chooser_id not in agent_ids:
        raise ContractError("chooser is not a participant")
    if not 1 <= day <= int(protocol["days"]):
        raise ContractError("day is outside protocol range")

    def rank(candidate_id: str) -> tuple[str, str]:
        label = [
            protocol["seed"],
            protocol["pairingBlockId"],
            "candidate_order",
            day,
            chooser_id,
            candidate_id,
        ]
        return (sha256(canonical_json(label).encode("utf-8")).hexdigest(), candidate_id)

    return sorted((item for item in agent_ids if item != chooser_id), key=rank)


def fallback_choice(protocol: Mapping[str, Any], day: int, chooser_id: str) -> str:
    candidates = candidate_order(protocol, day, chooser_id)
    label = [
        protocol["seed"],
        protocol["pairingBlockId"],
        "fallback_choice",
        day,
        chooser_id,
    ]
    value = int(sha256(canonical_json(label).encode("utf-8")).hexdigest(), 16)
    return candidates[value % len(candidates)]


def default_protocol() -> dict[str, Any]:
    """Small valid protocol used only by the platform scanner's cls() check."""

    return {
        "schemaVersion": PROTOCOL_SCHEMA_VERSION,
        "studyId": "memory-access-partner-choice",
        "runId": "scanner-default",
        "pairingBlockId": "scanner-default",
        "conditionId": "memory-none__gift-off",
        "replicate": 1,
        "seed": 1,
        "agentIds": ["1", "2", "3"],
        "profileSetHash": "sha256:scanner-default",
        "days": 1,
        "roundMinute": 1170,
        "manipulation": {"historyMode": "none", "giftExchange": False},
        "decision": {
            "policy": "llm",
            "contextPolicy": "observation_only_fresh_completion",
            "promptVersion": "partner-choice.prompt/v1",
            "fallback": "seeded_uniform",
            "modelRole": "primary",
            "modelId": "offline-contract-model",
            "temperature": 0.2,
            "topP": 1,
            "maxTokens": 256,
            "maxAttempts": 2,
            "maxFallbackRate": 0.05,
        },
    }


class PartnerChoiceCore:
    """Deterministic state machine for one condition × seed run."""

    def __init__(
        self,
        protocol: Mapping[str, Any] | None = None,
        agent_names: Mapping[str, str] | None = None,
        *,
        round_window_minutes: int = 60,
    ) -> None:
        self.protocol = deepcopy(dict(protocol or default_protocol()))
        validate_protocol(self.protocol)
        self.agent_names = {
            agent_id: str((agent_names or {}).get(agent_id, agent_id))
            for agent_id in self.protocol["agentIds"]
        }
        self.round_window_minutes = max(1, int(round_window_minutes))
        self.relationship_config = {
            "interactionAffectionDelta": 0.10,
            "interactionRespectDelta": 0.05,
            "clampMin": -1.0,
            "clampMax": 1.0,
            **dict(self.protocol.get("relationship", {})),
        }
        self.gift_config = {
            "item": "flower",
            "dailyIncome": 10.0,
            "price": 3.0,
            "senderAffectionDelta": 0.10,
            "receiverAffectionDelta": 0.05,
            **dict(self.protocol.get("gift", {})),
        }
        self.relationships: dict[str, dict[str, Any]] = {}
        self.histories: dict[str, list[dict[str, Any]]] = {}
        self.balances = {agent_id: 0.0 for agent_id in self.protocol["agentIds"]}
        self.current_round: dict[str, Any] | None = None
        self.next_day = 1
        self.step_count = 0
        self.event_seq = 0
        self.epoch_midnight: str | None = None
        self.events: list[dict[str, Any]] = []
        self.written_event_ids: set[str] = set()

    @staticmethod
    def _pair_key(agent_id: str, partner_id: str) -> str:
        return f"{agent_id}\u0000{partner_id}"

    def _relationship(self, agent_id: str, partner_id: str) -> dict[str, Any]:
        key = self._pair_key(agent_id, partner_id)
        if key not in self.relationships:
            self.relationships[key] = {
                "agentId": agent_id,
                "partnerId": partner_id,
                "affection": 0.0,
                "respect": 0.0,
                "interactionCount": 0,
                "lastInteractionStep": None,
                "giftsSent": 0,
                "giftsReceived": 0,
            }
        return self.relationships[key]

    def _history(self, agent_id: str, partner_id: str) -> list[dict[str, Any]]:
        return self.histories.setdefault(self._pair_key(agent_id, partner_id), [])

    def _clamp(self, value: float) -> float:
        return max(
            float(self.relationship_config["clampMin"]),
            min(float(self.relationship_config["clampMax"]), value),
        )

    def _emit(self, event_type: str, payload: dict[str, Any], *identity: Any) -> dict[str, Any]:
        self.event_seq += 1
        event_id = deterministic_id(
            self.protocol["runId"],
            payload.get("day"),
            payload.get("roundId"),
            *identity,
            event_type,
        )
        event = {
            "schemaVersion": EVENT_SCHEMA_VERSION,
            "eventType": event_type,
            "eventId": event_id,
            "eventSeq": self.event_seq,
            "runId": self.protocol["runId"],
            "pairingBlockId": self.protocol["pairingBlockId"],
            "conditionId": self.protocol["conditionId"],
            "protocolHash": protocol_hash(self.protocol),
            "profileSetHash": self.protocol["profileSetHash"],
            "replicate": self.protocol["replicate"],
            "seed": self.protocol["seed"],
            **payload,
        }
        self.events.append(event)
        return event

    def _visible_history(self, chooser_id: str, candidates: list[str]) -> dict[str, list[dict[str, Any]]]:
        mode = self.protocol["manipulation"]["historyMode"]
        if mode == "none":
            return {}
        recent_k = self.protocol["manipulation"].get("recentK")
        visible: dict[str, list[dict[str, Any]]] = {}
        for candidate_id in candidates:
            records = deepcopy(self._history(chooser_id, candidate_id))
            if mode == "recent_k":
                records = records[-int(recent_k) :]
            visible[candidate_id] = records
        return visible

    def open_round(self, day: int, step: int, t: datetime) -> dict[str, Any]:
        if self.current_round and self.current_round["status"] == "open":
            raise ContractError("a partner round is already open")
        if day != self.next_day:
            raise ContractError(f"expected day {self.next_day}, got {day}")
        round_id = f"day-{day:03d}-{self.protocol['roundMinute'] // 60:02d}{self.protocol['roundMinute'] % 60:02d}"
        for agent_id in self.protocol["agentIds"]:
            self.balances[agent_id] += float(self.gift_config["dailyIncome"])

        observations: dict[str, dict[str, Any]] = {}
        audits: dict[str, list[dict[str, Any]]] = {}
        for chooser_id in self.protocol["agentIds"]:
            candidates = candidate_order(self.protocol, day, chooser_id)
            visible = self._visible_history(chooser_id, candidates)
            audits[chooser_id] = [
                {
                    "id": candidate_id,
                    "name": self.agent_names[candidate_id],
                    "affection": self._relationship(chooser_id, candidate_id)["affection"],
                    "lastInteraction": self._relationship(chooser_id, candidate_id)["lastInteractionStep"],
                    "interactionCount": self._relationship(chooser_id, candidate_id)["interactionCount"],
                }
                for candidate_id in candidates
            ]
            observations[chooser_id] = {
                "schemaVersion": OBSERVATION_SCHEMA_VERSION,
                "day": day,
                "roundId": round_id,
                "chooserId": chooser_id,
                "candidates": [
                    {
                        "id": candidate_id,
                        "name": self.agent_names[candidate_id],
                        "history": deepcopy(visible.get(candidate_id, [])),
                    }
                    for candidate_id in candidates
                ],
            }

        self.current_round = {
            "status": "open",
            "day": day,
            "roundId": round_id,
            "step": step,
            "t": t.isoformat(),
            "openedAbsoluteMinute": self._absolute_minute(t),
            "scheduledAbsoluteMinute": (day - 1) * 1440 + int(self.protocol["roundMinute"]),
            "observations": observations,
            "audits": audits,
            "submissions": {},
        }
        self.next_day += 1
        return self.round_status()

    def observe(self, agent_id: str) -> dict[str, Any]:
        agent_id = str(agent_id)
        if agent_id not in self.protocol["agentIds"]:
            return {"ok": False, "code": "unknown_agent", "roundOpen": False}
        if not self.current_round or self.current_round["status"] != "open":
            return {"ok": True, "roundOpen": False}
        observation = deepcopy(self.current_round["observations"][agent_id])
        return {
            "ok": True,
            "roundOpen": True,
            "alreadySubmitted": agent_id in self.current_round["submissions"],
            "observation": observation,
        }

    def submit(
        self,
        agent_id: str,
        chosen_id: str,
        rationale: str = "",
        *,
        raw_response: str | None = None,
        attempt_count: int = 1,
        decision_audit: Mapping[str, Any] | None = None,
        submitted_step: int | None = None,
        submitted_at: datetime | None = None,
    ) -> dict[str, Any]:
        if submitted_at is not None:
            self.expire_at(submitted_at, step=submitted_step)
        agent_id = str(agent_id)
        chosen_id = str(chosen_id)
        current = self.current_round
        if not current or current["status"] != "open":
            return {"ok": False, "code": "round_not_open"}
        if agent_id not in self.protocol["agentIds"]:
            return {"ok": False, "code": "unknown_agent"}
        candidates = candidate_order(self.protocol, current["day"], agent_id)
        if chosen_id == agent_id or chosen_id not in candidates:
            return {"ok": False, "code": "invalid_candidate", "candidateIds": candidates}
        previous = current["submissions"].get(agent_id)
        if previous:
            if previous["chosenId"] == chosen_id:
                return {"ok": True, "duplicate": True, "eventId": previous["eventId"]}
            return {"ok": False, "code": "already_submitted"}

        audit = dict(decision_audit or {})
        source = "llm" if decision_audit is not None else "tool_submission"
        if decision_audit is not None:
            self._validate_llm_audit(chosen_id, audit)
        event = self._choice_event(
            agent_id,
            chosen_id,
            source=source,
            rationale=rationale,
            raw_response=(
                str(audit["rawResponse"])
                if decision_audit is not None
                else raw_response or canonical_json({"chosenId": chosen_id, "rationale": rationale})
            ),
            parse_status="valid",
            attempt_count=(int(audit["attemptCount"]) if decision_audit is not None else attempt_count),
            decision_audit=audit,
            event_step=submitted_step,
            event_time=submitted_at,
        )
        current["submissions"][agent_id] = {
            "chosenId": chosen_id,
            "eventId": event["eventId"],
            "source": source,
        }
        if len(current["submissions"]) == len(self.protocol["agentIds"]):
            self.finalize_round(step=submitted_step, t=submitted_at)
        return {"ok": True, "duplicate": False, "eventId": event["eventId"]}

    def _validate_llm_audit(self, chosen_id: str, audit: Mapping[str, Any]) -> None:
        decision = self.protocol["decision"]
        required_strings = ("modelId", "requestId", "renderedPromptHash", "rawResponse")
        for field in required_strings:
            if not isinstance(audit.get(field), str) or not str(audit[field]).strip():
                raise ContractError(f"decision audit requires {field}")
        if audit["modelId"] != decision["modelId"]:
            raise ContractError("decision audit modelId does not match protocol")
        if not str(audit["renderedPromptHash"]).startswith("sha256:"):
            raise ContractError("renderedPromptHash must be a SHA-256 tag")
        if audit.get("temperature") != decision["temperature"]:
            raise ContractError("decision audit temperature does not match protocol")
        if audit.get("topP") != decision["topP"]:
            raise ContractError("decision audit topP does not match protocol")
        if audit.get("maxTokens") != decision["maxTokens"]:
            raise ContractError("decision audit maxTokens does not match protocol")
        attempt_count = audit.get("attemptCount")
        if not isinstance(attempt_count, int) or not 1 <= attempt_count <= int(decision["maxAttempts"]):
            raise ContractError("decision audit attemptCount is outside protocol")
        try:
            parsed = json.loads(str(audit["rawResponse"]))
        except json.JSONDecodeError as exc:
            raise ContractError("decision audit rawResponse is not JSON") from exc
        if not isinstance(parsed, Mapping) or str(parsed.get("chosenId")) != chosen_id:
            raise ContractError("decision audit rawResponse does not match chosenId")

    def _choice_event(
        self,
        chooser_id: str,
        chosen_id: str,
        *,
        source: str,
        rationale: str,
        raw_response: str | None,
        parse_status: str,
        attempt_count: int,
        fallback_reason: str | None = None,
        decision_audit: Mapping[str, Any] | None = None,
        event_step: int | None = None,
        event_time: datetime | None = None,
    ) -> dict[str, Any]:
        assert self.current_round is not None
        current = self.current_round
        observation = current["observations"][chooser_id]
        candidates = candidate_order(self.protocol, current["day"], chooser_id)
        visible = self._visible_history(chooser_id, candidates)
        decision = self.protocol["decision"]
        audit = dict(decision_audit or {})
        payload = {
            "kind": "experiment_pair_choice",
            "mode": "off" if self.protocol["manipulation"]["historyMode"] == "none" else "on",
            "candidates": deepcopy(current["audits"][chooser_id]),
            "chosen": chosen_id,
            "fromId": chooser_id,
            "toId": chosen_id,
            "day": current["day"],
            "roundId": current["roundId"],
            "step": current["step"] if event_step is None else int(event_step),
            "t": current["t"] if event_time is None else event_time.isoformat(),
            "chooserId": chooser_id,
            "candidateIds": candidates,
            "chosenId": chosen_id,
            "historyMode": self.protocol["manipulation"]["historyMode"],
            "giftExchange": bool(self.protocol["manipulation"]["giftExchange"]),
            "visibleHistory": visible,
            "preChoiceCandidates": deepcopy(current["audits"][chooser_id]),
            "decision": {
                "source": source,
                "modelId": (
                    str(audit["modelId"])
                    if source == "llm"
                    else ("UNVERIFIED_TOOL_SUBMISSION" if source == "tool_submission" else str(decision["modelId"]))
                ),
                "temperature": float(decision["temperature"]),
                "topP": float(decision["topP"]),
                "maxTokens": int(decision["maxTokens"]),
                "promptHash": str(audit.get(
                    "renderedPromptHash",
                    tagged_hash({"promptVersion": decision["promptVersion"]}),
                )),
                "promptVersion": str(decision["promptVersion"]),
                "observationHash": tagged_hash(observation),
                "rawResponse": raw_response,
                "parsedChosenId": chosen_id if parse_status == "valid" else None,
                "parseStatus": parse_status,
                "attemptCount": max(1, min(int(attempt_count), int(decision["maxAttempts"]))),
                "rationale": rationale,
                **({"requestId": str(audit["requestId"])} if audit.get("requestId") else {}),
                **({"traceId": str(audit["traceId"])} if audit.get("traceId") else {}),
                **({"fallbackReason": fallback_reason} if fallback_reason else {}),
            },
        }
        return self._emit("partner_choice", payload, chooser_id)

    def finalize_round(
        self,
        fallback_reason: str = "round_deadline",
        *,
        step: int | None = None,
        t: datetime | None = None,
    ) -> dict[str, Any]:
        current = self.current_round
        if not current or current["status"] != "open":
            return self.round_status()
        for chooser_id in self.protocol["agentIds"]:
            if chooser_id in current["submissions"]:
                continue
            chosen_id = fallback_choice(self.protocol, current["day"], chooser_id)
            event = self._choice_event(
                chooser_id,
                chosen_id,
                source="seeded_fallback",
                rationale="",
                raw_response=None,
                parse_status="error",
                attempt_count=int(self.protocol["decision"]["maxAttempts"]),
                fallback_reason=fallback_reason,
                event_step=step,
                event_time=t,
            )
            current["submissions"][chooser_id] = {
                "chosenId": chosen_id,
                "eventId": event["eventId"],
                "source": "seeded_fallback",
            }
        self._apply_post_choice_effects(step=step, t=t)
        current["status"] = "closed"
        return self.round_status()

    def _apply_post_choice_effects(
        self,
        *,
        step: int | None = None,
        t: datetime | None = None,
    ) -> None:
        assert self.current_round is not None
        current = self.current_round
        effect_step = current["step"] if step is None else int(step)
        effect_time = current["t"] if t is None else t.isoformat()
        gift_on = bool(self.protocol["manipulation"]["giftExchange"])
        gifted: set[str] = set()

        for chooser_id in self.protocol["agentIds"]:
            chosen_id = current["submissions"][chooser_id]["chosenId"]
            if gift_on and self.balances[chooser_id] >= float(self.gift_config["price"]):
                self.balances[chooser_id] -= float(self.gift_config["price"])
                forward = self._relationship(chooser_id, chosen_id)
                reverse = self._relationship(chosen_id, chooser_id)
                forward["giftsSent"] += 1
                reverse["giftsReceived"] += 1
                forward["affection"] = self._clamp(
                    forward["affection"] + float(self.gift_config["senderAffectionDelta"])
                )
                reverse["affection"] = self._clamp(
                    reverse["affection"] + float(self.gift_config["receiverAffectionDelta"])
                )
                gifted.add(chooser_id)
                self._emit(
                    "gift",
                    {
                        "day": current["day"], "roundId": current["roundId"],
                        "step": effect_step, "t": effect_time,
                        "fromId": chooser_id, "toId": chosen_id,
                        "item": self.gift_config["item"], "price": self.gift_config["price"],
                        "choiceEventId": current["submissions"][chooser_id]["eventId"],
                    },
                    chooser_id,
                    chosen_id,
                )

        for chooser_id in self.protocol["agentIds"]:
            chosen_id = current["submissions"][chooser_id]["chosenId"]
            for source_id, target_id in ((chooser_id, chosen_id), (chosen_id, chooser_id)):
                relation = self._relationship(source_id, target_id)
                relation["affection"] = self._clamp(
                    relation["affection"] + float(self.relationship_config["interactionAffectionDelta"])
                )
                relation["respect"] = self._clamp(
                    relation["respect"] + float(self.relationship_config["interactionRespectDelta"])
                )
                relation["interactionCount"] += 1
                relation["lastInteractionStep"] = effect_step
            interaction_id = deterministic_id(
                self.protocol["runId"], current["roundId"], chooser_id, chosen_id, "interaction"
            )
            sent_gift = chooser_id in gifted
            summary = f"{self.agent_names[chooser_id]} 与 {self.agent_names[chosen_id]} 完成了伙伴互动。"
            if sent_gift:
                summary += f"互动前，{self.agent_names[chooser_id]}赠送了一束花。"
            self._history(chooser_id, chosen_id).append({
                "id": interaction_id,
                "day": current["day"],
                "gameTime": effect_step,
                "summary": summary,
                "giftSent": sent_gift,
                "giftReceived": False,
            })
            self._history(chosen_id, chooser_id).append({
                "id": interaction_id,
                "day": current["day"],
                "gameTime": effect_step,
                "summary": summary,
                "giftSent": False,
                "giftReceived": sent_gift,
            })
            self._emit(
                "interaction",
                {
                    "day": current["day"], "roundId": current["roundId"],
                    "step": effect_step, "t": effect_time,
                    "fromId": chooser_id, "toId": chosen_id, "status": "completed",
                    "summary": summary, "giftSent": sent_gift,
                    "choiceEventId": current["submissions"][chooser_id]["eventId"],
                },
                chooser_id,
                chosen_id,
            )

        for agent_id in self.protocol["agentIds"]:
            for partner_id in self.protocol["agentIds"]:
                if agent_id == partner_id:
                    continue
                relation = deepcopy(self._relationship(agent_id, partner_id))
                self._emit(
                    "relationship_state",
                    {
                        "day": current["day"], "roundId": current["roundId"],
                        "step": effect_step, "t": effect_time,
                        "relationId": f"{agent_id}->{partner_id}",
                        **relation,
                    },
                    agent_id,
                    partner_id,
                )

    def _absolute_minute(self, t: datetime) -> int:
        if self.epoch_midnight is None:
            midnight = t.replace(hour=0, minute=0, second=0, microsecond=0)
            self.epoch_midnight = midnight.isoformat()
        epoch = datetime.fromisoformat(self.epoch_midnight)
        return math.floor((t - epoch).total_seconds() / 60)

    def expire_at(self, t: datetime, *, step: int | None = None) -> bool:
        """Close an open round at its scheduled deadline before accepting tools."""

        if not self.current_round or self.current_round["status"] != "open":
            return False
        absolute_minute = self._absolute_minute(t)
        scheduled = int(
            self.current_round.get(
                "scheduledAbsoluteMinute",
                self.current_round["openedAbsoluteMinute"],
            )
        )
        if absolute_minute < scheduled + self.round_window_minutes:
            return False
        self.finalize_round(step=step, t=t)
        return True

    def advance(self, tick: int, t: datetime) -> dict[str, Any]:
        """Advance scheduling to the supplied authoritative simulation time."""

        del tick
        self.step_count += 1
        absolute_minute = self._absolute_minute(t)
        self.expire_at(t, step=self.step_count)

        while self.next_day <= int(self.protocol["days"]):
            scheduled = (self.next_day - 1) * 1440 + int(self.protocol["roundMinute"])
            if absolute_minute < scheduled:
                break
            if self.current_round and self.current_round["status"] == "open":
                break
            epoch = datetime.fromisoformat(str(self.epoch_midnight))
            scheduled_time = epoch + timedelta(minutes=scheduled)
            self.open_round(self.next_day, self.step_count, scheduled_time)
            if absolute_minute >= scheduled + self.round_window_minutes:
                self.finalize_round(
                    "late_or_skipped_round",
                    step=self.step_count,
                    t=t,
                )
                continue
            break
        return self.round_status()

    def round_status(self) -> dict[str, Any]:
        current = self.current_round
        return {
            "schemaVersion": STATE_SCHEMA_VERSION,
            "runId": self.protocol["runId"],
            "conditionId": self.protocol["conditionId"],
            "day": current["day"] if current else 0,
            "roundId": current["roundId"] if current else None,
            "status": current["status"] if current else "waiting",
            "submitted": len(current["submissions"]) if current else 0,
            "expected": len(self.protocol["agentIds"]),
            "nextDay": self.next_day,
        }

    def drain_events(self) -> list[dict[str, Any]]:
        pending = self.events
        self.events = []
        return pending

    def to_state(self) -> dict[str, Any]:
        return {
            "schemaVersion": STATE_SCHEMA_VERSION,
            "protocol": deepcopy(self.protocol),
            "agentNames": deepcopy(self.agent_names),
            "roundWindowMinutes": self.round_window_minutes,
            "relationships": deepcopy(self.relationships),
            "histories": deepcopy(self.histories),
            "balances": deepcopy(self.balances),
            "currentRound": deepcopy(self.current_round),
            "nextDay": self.next_day,
            "stepCount": self.step_count,
            "eventSeq": self.event_seq,
            "epochMidnight": self.epoch_midnight,
            "pendingEvents": deepcopy(self.events),
            "writtenEventIds": sorted(self.written_event_ids),
        }

    @classmethod
    def from_state(cls, state: Mapping[str, Any]) -> "PartnerChoiceCore":
        if state.get("schemaVersion") != STATE_SCHEMA_VERSION:
            raise ContractError("checkpoint schemaVersion mismatch")
        core = cls(
            state["protocol"],
            state.get("agentNames"),
            round_window_minutes=int(state.get("roundWindowMinutes", 60)),
        )
        core.relationships = deepcopy(dict(state.get("relationships", {})))
        core.histories = deepcopy(dict(state.get("histories", {})))
        core.balances = {str(k): float(v) for k, v in dict(state.get("balances", {})).items()}
        core.current_round = deepcopy(state.get("currentRound"))
        core.next_day = int(state.get("nextDay", 1))
        core.step_count = int(state.get("stepCount", 0))
        core.event_seq = int(state.get("eventSeq", 0))
        core.epoch_midnight = state.get("epochMidnight")
        core.events = deepcopy(list(state.get("pendingEvents", [])))
        core.written_event_ids = set(state.get("writtenEventIds", []))
        return core
