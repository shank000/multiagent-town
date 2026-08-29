from __future__ import annotations

from collections import defaultdict
import json
from pathlib import Path
import unittest

from custom.partner_choice_core import candidate_order, protocol_hash, validate_protocol
from protocol.generate_run_matrix import MANIFEST_PATH, build_matrix


class RunMatrixTest(unittest.TestCase):
    def test_manifest_freezes_confirmatory_estimand_and_missingness_rules(self) -> None:
        manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
        analysis = manifest["analysis"]
        self.assertEqual(manifest["executionOrderPolicy"], "sha256_seeded_condition_order/v1")
        self.assertEqual(analysis["replicateUnit"], "condition_by_seed_run")
        self.assertEqual(
            analysis["confirmatoryOutcome"],
            {
                "metric": "directed_edge_repeat_rate",
                "windowDays": [31, 60],
                "withinRunAggregation": "arithmetic_mean",
            },
        )
        self.assertEqual(analysis["inference"]["minimumTwoSidedExactP"], 0.0625)
        self.assertFalse(analysis["inference"]["alpha05ConfirmatoryRejectionSupported"])
        self.assertEqual(analysis["missingness"]["lateOrSkippedRound"], "invalidate_run")

    def test_matrix_freezes_all_core_and_robustness_runs(self) -> None:
        matrix = build_matrix()
        self.assertEqual(matrix["schemaVersion"], "partner-choice.run-matrix/v1")
        self.assertEqual(len(matrix["pairingBlocks"]), 5)
        self.assertEqual(len(matrix["runs"]), 30)
        for replicate in range(1, 6):
            orders = [
                run["executionOrder"]
                for run in matrix["runs"]
                if run["protocol"]["replicate"] == replicate
            ]
            self.assertEqual(orders, list(range(1, 7)))
        self.assertEqual(len({run["protocol"]["runId"] for run in matrix["runs"]}), 30)
        self.assertEqual(
            sum("memory-recent3" in run["protocol"]["conditionId"] for run in matrix["runs"]),
            10,
        )
        for run in matrix["runs"]:
            protocol = run["protocol"]
            validate_protocol(protocol)
            self.assertEqual(protocol_hash(protocol), run["protocolHash"])
            self.assertEqual(len(protocol["agentIds"]), 24)
            self.assertEqual(protocol["agentIds"], [str(index) for index in range(1, 25)])

    def test_paired_arms_share_profiles_candidate_sets_order_and_decision_policy(self) -> None:
        by_seed = defaultdict(list)
        for run in build_matrix()["runs"]:
            by_seed[run["protocol"]["seed"]].append(run["protocol"])
        for protocols in by_seed.values():
            reference = protocols[0]
            for protocol in protocols[1:]:
                self.assertEqual(protocol["pairingBlockId"], reference["pairingBlockId"])
                self.assertEqual(protocol["profileSetHash"], reference["profileSetHash"])
                self.assertEqual(protocol["agentIds"], reference["agentIds"])
                self.assertEqual(protocol["decision"], reference["decision"])
                for chooser_id in reference["agentIds"]:
                    self.assertEqual(
                        candidate_order(protocol, 1, chooser_id),
                        candidate_order(reference, 1, chooser_id),
                    )

    def test_committed_matrix_is_the_canonical_generator_output(self) -> None:
        path = Path(__file__).resolve().parents[1] / "protocol" / "run-matrix.v1.json"
        committed = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(committed, build_matrix())


if __name__ == "__main__":
    unittest.main()
