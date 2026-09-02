from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
import tempfile
import unittest

from custom.partner_choice_core import PartnerChoiceCore, candidate_order, default_protocol
from execution.quality import build_quality_report, write_quality_report


def completed_fixture() -> tuple[dict, list[dict]]:
    protocol = default_protocol()
    protocol["runId"] = "quality-fixture"
    protocol["decision"]["modelId"] = "online/formal-model-v1"
    protocol["interaction"] = {
        "policy": "llm_audited",
        "modelId": "online/formal-model-v1",
        "promptVersion": "partner-choice.interaction/v1",
        "maxTokens": 192,
        "maxAttempts": 2,
    }
    core = PartnerChoiceCore(protocol)
    core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
    for chooser in protocol["agentIds"]:
        chosen = candidate_order(protocol, 1, chooser)[0]
        raw_choice = json.dumps({"chosenId": chosen, "rationale": "fixture"})
        decision = protocol["decision"]
        core.submit(chooser, chosen, decision_audit={
            "modelId": decision["modelId"],
            "requestId": f"choice-{chooser}",
            "renderedPromptHash": f"sha256:choice-{chooser}",
            "rawResponse": raw_choice,
            "temperature": decision["temperature"],
            "topP": decision["topP"],
            "maxTokens": decision["maxTokens"],
            "attemptCount": 1,
            "inputTokens": 20,
            "outputTokens": 5,
            "totalTokens": 25,
        })
        summary = f"Agent {chooser} completed a short exchange with Agent {chosen}."
        core.submit_interaction(chooser, summary, {
            "source": "llm",
            "modelId": protocol["interaction"]["modelId"],
            "requestId": f"interaction-{chooser}",
            "renderedPromptHash": f"sha256:interaction-{chooser}",
            "rawResponse": json.dumps({"summary": summary}),
            "attemptCount": 1,
            "inputTokens": 12,
            "outputTokens": 8,
            "totalTokens": 20,
        })
    return protocol, core.drain_events()


class ExecutionQualityTest(unittest.TestCase):
    def test_complete_audited_run_passes_and_serializes_without_secrets(self) -> None:
        protocol, events = completed_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "replay").mkdir()
            (root / "checkpoint").mkdir()
            (root / "replay" / "rows.jsonl").write_text("x" * 20, encoding="utf-8")
            (root / "checkpoint" / "state.json").write_text("x" * 10, encoding="utf-8")
            report = build_quality_report(
                protocol, events, duration_ms=123.456,
                replay_dir=root / "replay", checkpoint_dir=root / "checkpoint",
                sdk_token_stats={"default": {"total_tokens": 135}},
            )
            self.assertTrue(report["formalGatePassed"])
            self.assertEqual(report["completion"]["rate"], 1.0)
            self.assertEqual(report["calls"]["choiceEvents"], len(protocol["agentIds"]))
            self.assertEqual(report["calls"]["interactionEvents"], len(protocol["agentIds"]))
            self.assertEqual(report["tokens"]["choices"]["totalTokens"], 75)
            self.assertEqual(report["tokens"]["interactions"]["totalTokens"], 60)
            output = root / "quality.json"
            write_quality_report(report, output)
            serialized = output.read_text(encoding="utf-8")
            self.assertNotIn("API_KEY", serialized)
            self.assertNotIn("credential", serialized.lower())

    def test_incomplete_duplicate_late_and_excess_fallback_fail_formal_gate(self) -> None:
        protocol, events = completed_fixture()
        broken = deepcopy(events)
        interaction_index = next(index for index, event in enumerate(broken) if event["eventType"] == "interaction")
        broken.pop(interaction_index)
        choice = next(event for event in broken if event["eventType"] == "partner_choice")
        choice["decision"]["source"] = "seeded_fallback"
        choice["decision"]["fallbackReason"] = "late_or_skipped_round"
        broken.append(deepcopy(choice))
        with tempfile.TemporaryDirectory() as temporary:
            report = build_quality_report(
                protocol, broken, duration_ms=1,
                replay_dir=Path(temporary) / "replay",
                checkpoint_dir=Path(temporary) / "checkpoint",
            )
        self.assertFalse(report["formalGatePassed"])
        self.assertGreater(report["integrity"]["duplicateEventIds"], 0)
        self.assertIn("late_or_skipped", report["integrity"]["errorClasses"])
        self.assertIn("fallback_rate", report["integrity"]["errorClasses"])
        self.assertLess(report["completion"]["rate"], 1.0)


if __name__ == "__main__":
    unittest.main()
