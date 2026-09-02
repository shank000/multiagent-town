from __future__ import annotations

import json
from pathlib import Path
import unittest

from analysis.metrics import choices_from_events, metrics_of


ROOT = Path(__file__).resolve().parents[3]
GOLDEN = ROOT / "tests" / "fixtures" / "partner-choice-v1.jsonl"
METRICS_GOLDEN = ROOT / "tests" / "fixtures" / "metrics-parity-v1.json"
SEQUENCE_KEYS = (
    "repeat", "recipRate", "recipBaseline", "recip", "clus", "div", "hhi", "persistence", "hub"
)


class MetricsParityTest(unittest.TestCase):
    def test_complete_sequences_match_shared_typescript_python_golden(self) -> None:
        fixture = json.loads(METRICS_GOLDEN.read_text(encoding="utf-8"))
        self.assertEqual(fixture["schemaVersion"], "metrics-parity.fixture/v1")
        choices = [
            (day["day"], sender, receiver)
            for day in fixture["days"]
            for sender, receiver in day["choices"]
        ]
        actual = metrics_of(choices, fixture["agentIds"])
        expected = fixture["expected"]

        for key in SEQUENCE_KEYS:
            self.assertEqual(len(actual[key]), len(expected[key]), f"{key} sequence length")
            for index, (actual_value, expected_value) in enumerate(zip(actual[key], expected[key])):
                self.assertAlmostEqual(
                    actual_value,
                    expected_value,
                    places=12,
                    msg=f"{key}[{index}]",
                )
        self.assertEqual(actual["pairs"], expected["pairs"])
        self.assertEqual(actual["seriesDays"]["persistence"], [14, 15, 16])
        self.assertEqual(actual["availability"]["persistence"]["state"], "ready")

    def test_golden_choice_projection_matches_typescript_metric_semantics(self) -> None:
        rows = [json.loads(line) for line in GOLDEN.read_text(encoding="utf-8").splitlines()]
        protocol = rows[0]["payload"]
        events = [row["payload"] for row in rows[1:]]
        metrics = metrics_of(choices_from_events(events), protocol["agentIds"])
        self.assertEqual(metrics["repeat"], [])
        self.assertEqual(metrics["recipRate"], [])
        self.assertEqual(metrics["recipBaseline"], [])
        self.assertEqual(metrics["recip"], [])
        self.assertEqual(metrics["clus"], [0.0])
        self.assertEqual(metrics["div"], [1.0])
        self.assertEqual(metrics["hhi"], [1.0])
        self.assertEqual(metrics["persistence"], [])
        self.assertEqual(metrics["hub"], [0.5])
        self.assertEqual(metrics["pairs"], {"0:1": 1, "1:0": 1, "2:1": 1})

    def test_two_day_fixture_covers_repetition_and_zero_reciprocity(self) -> None:
        agent_ids = ["a", "b", "c", "d"]
        choices = [
            (1, "a", "b"), (1, "b", "c"), (1, "c", "d"), (1, "d", "a"),
            (2, "a", "b"), (2, "b", "c"), (2, "c", "d"), (2, "d", "a"),
        ]
        metrics = metrics_of(choices, agent_ids)
        self.assertEqual(metrics["repeat"], [1.0])
        self.assertEqual(metrics["hhi"], [1.0, 1.0])
        self.assertEqual(metrics["recip"], [0.0])
        self.assertEqual(metrics["recipRate"], [0.0])
        self.assertEqual(metrics["recipBaseline"], [1 / 3])
        self.assertEqual(metrics["persistence"], [])
        self.assertEqual(metrics["hub"], [0.0, 0.0])

    def test_fourteen_days_compare_non_overlapping_seven_day_matrices(self) -> None:
        agent_ids = ["a", "b", "c", "d"]
        choices = [
            (day, sender, receiver)
            for day in range(1, 15)
            for sender, receiver in (("a", "b"), ("b", "c"), ("c", "d"), ("d", "a"))
        ]
        metrics = metrics_of(choices, agent_ids)
        self.assertEqual(metrics["persistence"], [1.0])
        self.assertEqual(metrics["seriesDays"]["persistence"], [14])
        self.assertEqual(metrics["availability"]["persistence"]["state"], "ready")

    def test_repeat_does_not_compare_across_missing_calendar_days(self) -> None:
        metrics = metrics_of([(1, "a", "b"), (3, "a", "b")], ["a", "b"])
        self.assertEqual(metrics["repeat"], [])

    def test_persistence_reports_pending_window_as_missing_not_zero(self) -> None:
        choices = [(day, "a", "b") for day in range(1, 14)]
        metrics = metrics_of(choices, ["a", "b", "c"])
        self.assertEqual(metrics["persistence"], [])
        self.assertEqual(metrics["availability"]["persistence"], {
            "state": "awaiting_window",
            "observedPoints": 0,
            "observedChoiceDays": 13,
            "longestConsecutiveChoiceDays": 13,
            "requiredConsecutiveChoiceDays": 14,
        })

    def test_invalid_choices_do_not_enter_measurement_sequences(self) -> None:
        metrics = metrics_of([
            (1, "a", "b"),
            (1, "a", "a"),
            (1, "outside", "b"),
            (0, "b", "a"),
        ], ["a", "b", "c"])
        self.assertEqual(metrics["seriesDays"]["clus"], [1])
        self.assertEqual(metrics["pairs"], {"0:1": 1})


if __name__ == "__main__":
    unittest.main()
