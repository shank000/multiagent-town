from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import unittest

from custom.partner_choice_core import (
    PartnerChoiceCore,
    candidate_order,
    canonical_json,
    protocol_hash,
)


ROOT = Path(__file__).resolve().parents[3]
GOLDEN = ROOT / "tests" / "fixtures" / "partner-choice-v1.jsonl"


def golden_records() -> tuple[dict, list[dict]]:
    rows = [json.loads(line) for line in GOLDEN.read_text(encoding="utf-8").splitlines() if line]
    return rows[0]["payload"], [row["payload"] for row in rows[1:]]


def protocol(*, mode: str = "full", gift: bool = False, days: int = 2) -> dict:
    base, _ = golden_records()
    value = deepcopy(base)
    value["runId"] = f"test-{mode}-gift-{gift}"
    value["conditionId"] = f"memory-{mode}__gift-{'on' if gift else 'off'}"
    value["days"] = days
    value["manipulation"] = {"historyMode": mode, "giftExchange": gift}
    if mode == "recent_k":
        value["manipulation"]["recentK"] = 1
    return value


def names(p: dict) -> dict[str, str]:
    return {agent_id: f"Agent {agent_id}" for agent_id in p["agentIds"]}


def submit_first_candidates(core: PartnerChoiceCore) -> None:
    assert core.current_round is not None
    day = core.current_round["day"]
    for chooser_id in core.protocol["agentIds"]:
        chosen_id = candidate_order(core.protocol, day, chooser_id)[0]
        result = core.submit(chooser_id, chosen_id, "visible-observation decision")
        assert result["ok"]


class PartnerChoiceCoreTest(unittest.TestCase):
    def test_cross_runtime_golden_hash_and_candidate_order(self) -> None:
        golden_protocol, events = golden_records()
        self.assertEqual(
            protocol_hash(golden_protocol),
            "sha256:10b16a57bd8cff317777920c3013f872f6e8eb29797ba5c04f9c2f1ef45e67a7",
        )
        for event in events:
            self.assertEqual(
                candidate_order(golden_protocol, event["day"], event["chooserId"]),
                event["candidateIds"],
            )

    def test_none_and_full_share_candidate_order_but_not_history_content(self) -> None:
        full_protocol = protocol(mode="full")
        none_protocol = protocol(mode="none")
        none_protocol["pairingBlockId"] = full_protocol["pairingBlockId"]
        none_protocol["seed"] = full_protocol["seed"]
        full = PartnerChoiceCore(full_protocol, names(full_protocol))
        none = PartnerChoiceCore(none_protocol, names(none_protocol))
        start = datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc)

        full.open_round(1, 1, start)
        none.open_round(1, 1, start)
        submit_first_candidates(full)
        submit_first_candidates(none)
        full.drain_events()
        none.drain_events()
        full.open_round(2, 2, start + timedelta(days=1))
        none.open_round(2, 2, start + timedelta(days=1))

        for chooser_id in full_protocol["agentIds"]:
            full_observation = full.observe(chooser_id)["observation"]
            none_observation = none.observe(chooser_id)["observation"]
            self.assertEqual(
                set(full_observation),
                {"schemaVersion", "day", "roundId", "chooserId", "candidates"},
            )
            self.assertTrue(all(set(item) == {"id", "name", "history"} for item in full_observation["candidates"]))
            self.assertEqual(
                [item["id"] for item in full_observation["candidates"]],
                [item["id"] for item in none_observation["candidates"]],
            )
            self.assertTrue(all(item["history"] == [] for item in none_observation["candidates"]))
        self.assertTrue(
            any(
                item["history"]
                for chooser_id in full_protocol["agentIds"]
                for item in full.observe(chooser_id)["observation"]["candidates"]
            )
        )

    def test_gift_enters_only_later_visible_history(self) -> None:
        start = datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc)
        observations: dict[tuple[str, bool], dict] = {}
        for mode in ("none", "full"):
            for gift in (False, True):
                p = protocol(mode=mode, gift=gift)
                core = PartnerChoiceCore(p, names(p))
                core.open_round(1, 1, start)
                submit_first_candidates(core)
                core.drain_events()
                core.open_round(2, 2, start + timedelta(days=1))
                observations[(mode, gift)] = core.observe(p["agentIds"][0])["observation"]

        self.assertEqual(observations[("none", False)], observations[("none", True)])
        self.assertNotEqual(observations[("full", False)], observations[("full", True)])
        gift_records = [
            record
            for candidate in observations[("full", True)]["candidates"]
            for record in candidate["history"]
        ]
        self.assertTrue(any(record["giftSent"] or record["giftReceived"] for record in gift_records))

    def test_all_choice_events_precede_gifts_and_use_pre_treatment_snapshot(self) -> None:
        p = protocol(mode="full", gift=True, days=1)
        core = PartnerChoiceCore(p, names(p))
        core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        submit_first_candidates(core)
        events = core.drain_events()
        n = len(p["agentIds"])

        self.assertEqual([event["eventType"] for event in events[:n]], ["partner_choice"] * n)
        self.assertEqual([event["eventType"] for event in events[n : 2 * n]], ["gift"] * n)
        for event in events[:n]:
            self.assertTrue(all(item["affection"] == 0 for item in event["preChoiceCandidates"]))
        snapshots = [event for event in events if event["eventType"] == "relationship_state"]
        self.assertTrue(any(event["affection"] > 0 for event in snapshots))

    def test_checkpoint_resume_preserves_fallback_and_event_identity(self) -> None:
        p = protocol(mode="recent_k", days=1)
        original = PartnerChoiceCore(p, names(p))
        original.open_round(1, 7, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        chooser = p["agentIds"][0]
        original.submit(chooser, candidate_order(p, 1, chooser)[0], "one submitted choice")
        original.drain_events()
        restored = PartnerChoiceCore.from_state(json.loads(canonical_json(original.to_state())))

        original.finalize_round()
        restored.finalize_round()
        self.assertEqual(canonical_json(original.drain_events()), canonical_json(restored.drain_events()))
        self.assertEqual(canonical_json(original.to_state()), canonical_json(restored.to_state()))

    def test_scheduler_opens_round_and_deadline_supplies_missing_choices(self) -> None:
        p = protocol(mode="none", days=1)
        core = PartnerChoiceCore(p, names(p), round_window_minutes=30)
        midnight = datetime(2026, 1, 1, tzinfo=timezone.utc)
        core.advance(60, midnight)
        self.assertEqual(core.round_status()["status"], "waiting")
        core.advance(60, midnight + timedelta(minutes=1170))
        self.assertEqual(core.round_status()["status"], "open")
        core.advance(60, midnight + timedelta(minutes=1200))
        self.assertEqual(core.round_status()["status"], "closed")
        choices = [event for event in core.drain_events() if event["eventType"] == "partner_choice"]
        self.assertEqual(len(choices), len(p["agentIds"]))
        self.assertTrue(all(event["decision"]["source"] == "seeded_fallback" for event in choices))

    def test_invalid_and_duplicate_submissions_are_structured(self) -> None:
        p = protocol(mode="none", days=1)
        core = PartnerChoiceCore(p, names(p))
        core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        chooser = p["agentIds"][0]
        chosen = candidate_order(p, 1, chooser)[0]
        self.assertEqual(core.submit(chooser, chooser)["code"], "invalid_candidate")
        first = core.submit(chooser, chosen)
        duplicate = core.submit(chooser, chosen)
        conflict = core.submit(chooser, candidate_order(p, 1, chooser)[1])
        self.assertTrue(first["ok"])
        first_event = next(event for event in core.events if event["eventType"] == "partner_choice")
        self.assertEqual(first_event["decision"]["source"], "tool_submission")
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(conflict["code"], "already_submitted")

    def test_llm_source_requires_complete_matching_decision_audit(self) -> None:
        p = protocol(mode="none", days=1)
        core = PartnerChoiceCore(p, names(p))
        core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        chooser = p["agentIds"][0]
        chosen = candidate_order(p, 1, chooser)[0]
        decision = p["decision"]
        audit = {
            "modelId": decision["modelId"], "requestId": "request-1",
            "renderedPromptHash": "sha256:prompt", "rawResponse": json.dumps({"chosenId": chosen}),
            "temperature": decision["temperature"], "topP": decision["topP"],
            "maxTokens": decision["maxTokens"], "attemptCount": 1,
        }
        self.assertTrue(core.submit(chooser, chosen, decision_audit=audit)["ok"])
        event = next(event for event in core.events if event["eventType"] == "partner_choice")
        self.assertEqual(event["decision"]["source"], "llm")
        self.assertEqual(event["decision"]["requestId"], "request-1")


if __name__ == "__main__":
    unittest.main()
