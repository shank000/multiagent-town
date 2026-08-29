from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone
import json
import unittest

from analysis.validate_run import validate_events
from custom.partner_choice_core import PartnerChoiceCore, candidate_order, default_protocol


class ValidateRunTest(unittest.TestCase):
    @staticmethod
    def audited_submit(core: PartnerChoiceCore, protocol: dict, chooser: str, chosen: str) -> None:
        raw = json.dumps({"chosenId": chosen, "rationale": "fixture"}, separators=(",", ":"))
        decision = protocol["decision"]
        core.submit(
            chooser,
            chosen,
            "fixture",
            decision_audit={
                "modelId": decision["modelId"],
                "requestId": f"request-{chooser}",
                "renderedPromptHash": "sha256:fixture-prompt",
                "rawResponse": raw,
                "temperature": decision["temperature"],
                "topP": decision["topP"],
                "maxTokens": decision["maxTokens"],
                "attemptCount": 1,
            },
        )

    def complete_run(self) -> tuple[dict, list[dict]]:
        protocol = default_protocol()
        core = PartnerChoiceCore(protocol)
        core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        for chooser in protocol["agentIds"]:
            self.audited_submit(core, protocol, chooser, candidate_order(protocol, 1, chooser)[0])
        return protocol, core.drain_events()

    def test_complete_core_run_passes_every_gate(self) -> None:
        protocol, events = self.complete_run()
        self.assertEqual(validate_events(protocol, events), [])

    def test_validator_reports_history_leak_duplicate_and_missing_choice(self) -> None:
        protocol, events = self.complete_run()
        broken = deepcopy(events)
        choice = next(event for event in broken if event["eventType"] == "partner_choice")
        choice["visibleHistory"] = {choice["candidateIds"][0]: []}
        broken.append(deepcopy(choice))
        errors = validate_events(protocol, broken)
        self.assertTrue(any("leaked history" in error for error in errors))
        self.assertTrue(any("duplicate eventId" in error for error in errors))
        self.assertTrue(any("expected 3 choices" in error for error in errors))

    def test_validator_rejects_unaudited_tool_submissions(self) -> None:
        protocol = default_protocol()
        core = PartnerChoiceCore(protocol)
        core.open_round(1, 1, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        for chooser in protocol["agentIds"]:
            core.submit(chooser, candidate_order(protocol, 1, chooser)[0])
        errors = validate_events(protocol, core.drain_events())
        self.assertTrue(any("unaudited decision source" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
