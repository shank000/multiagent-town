from __future__ import annotations

from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from custom.partner_choice_core import tagged_hash
from execution.preflight import PreflightError, preflight_run
from execution.stage_bundle import StageError, build_execution_bundle


ROOT = Path(__file__).resolve().parents[1]
MODEL = "online/formal-model-v1"


class ExecutionStagingTest(unittest.TestCase):
    def environment(self) -> dict[str, str]:
        return {
            "AGENTSOCIETY_LLM_API_KEY": "test-only-not-persisted",
            "AGENTSOCIETY_LLM_API_BASE": "https://model.invalid/v1",
            "AGENTSOCIETY_LLM_MODEL": MODEL,
            "WORKSPACE_PATH": str(ROOT),
        }

    def test_all_stages_are_deterministic_and_have_declared_sizes(self) -> None:
        expected = {
            "online-smoke": (1, 1, 2),
            "capacity": (4, 2, 24),
            "preflight": (4, 5, 24),
            "main": (20, 60, 24),
            "robustness": (10, 60, 24),
        }
        before_manifest = (ROOT / "experiment-manifest.v1.json").read_bytes()
        before_matrix = (ROOT / "protocol" / "run-matrix.v1.json").read_bytes()
        for stage, (run_count, days, agents) in expected.items():
            first = build_execution_bundle(ROOT, stage, MODEL)
            second = build_execution_bundle(ROOT, stage, MODEL)
            self.assertEqual(first, second)
            self.assertEqual(first["bundleHash"], tagged_hash({k: v for k, v in first.items() if k != "bundleHash"}))
            self.assertEqual(len(first["runs"]), run_count)
            self.assertTrue(all(item["protocol"]["days"] == days for item in first["runs"]))
            self.assertTrue(all(len(item["agents"]) == agents for item in first["runs"]))
            self.assertEqual(first["analysisUnit"]["independent"], "condition_by_seed_world_run")
        self.assertEqual((ROOT / "experiment-manifest.v1.json").read_bytes(), before_manifest)
        self.assertEqual((ROOT / "protocol" / "run-matrix.v1.json").read_bytes(), before_matrix)

    def test_stage_rejects_placeholder_model(self) -> None:
        with self.assertRaises(StageError):
            build_execution_bundle(ROOT, "main", "ONLINE_WORKSPACE_REQUIRED")

    def test_preflight_accepts_empty_fresh_dir_and_rejects_every_hard_gate(self) -> None:
        bundle = build_execution_bundle(ROOT, "online-smoke", MODEL)
        run_id = bundle["runs"][0]["protocol"]["runId"]
        with tempfile.TemporaryDirectory() as temporary:
            empty = Path(temporary) / "new-run"
            empty.mkdir()
            selected = preflight_run(
                bundle, ROOT, run_id, empty,
                environment=self.environment(), package_version="2.8.4", python_version=(3, 11), ray_available=True,
            )
            self.assertEqual(selected["protocol"]["runId"], run_id)
            (empty / "occupied.txt").write_text("existing", encoding="utf-8")
            with self.assertRaisesRegex(PreflightError, "non-empty"):
                preflight_run(bundle, ROOT, run_id, empty, environment=self.environment(), package_version="2.8.4", ray_available=True)

        bad = deepcopy(bundle)
        bad["modelId"] = "other"
        bad["bundleHash"] = tagged_hash({k: v for k, v in bad.items() if k != "bundleHash"})
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(PreflightError, "decision model"):
                preflight_run(bad, ROOT, run_id, Path(temporary), environment=self.environment(), package_version="2.8.4", ray_available=True)
            missing = self.environment()
            del missing["AGENTSOCIETY_LLM_API_KEY"]
            with self.assertRaisesRegex(PreflightError, "missing critical"):
                preflight_run(bundle, ROOT, run_id, Path(temporary), environment=missing, package_version="2.8.4", ray_available=True)
            with self.assertRaisesRegex(PreflightError, "exactly 2.8.4"):
                preflight_run(bundle, ROOT, run_id, Path(temporary), environment=self.environment(), package_version="2.8.3", ray_available=True)
            with self.assertRaisesRegex(PreflightError, "Python"):
                preflight_run(bundle, ROOT, run_id, Path(temporary), environment=self.environment(), package_version="2.8.4", python_version=(3, 10), ray_available=True)
            with self.assertRaisesRegex(PreflightError, "SDK_RAY_UNAVAILABLE"):
                preflight_run(bundle, ROOT, run_id, Path(temporary), environment=self.environment(), package_version="2.8.4", ray_available=False)

    def test_resume_requires_matching_immutable_metadata(self) -> None:
        bundle = build_execution_bundle(ROOT, "online-smoke", MODEL)
        run_id = bundle["runs"][0]["protocol"]["runId"]
        with tempfile.TemporaryDirectory() as temporary:
            run_dir = Path(temporary)
            (run_dir / "formal-run.json").write_text(json.dumps({
                "bundleHash": bundle["bundleHash"], "runId": run_id,
            }), encoding="utf-8")
            (run_dir / "protocol.json").write_text(json.dumps(bundle["runs"][0]["protocol"]), encoding="utf-8")
            (run_dir / "SOCIETY.json").write_text("{}", encoding="utf-8")
            (run_dir / "SOCIETY_STEP.json").write_text("{}", encoding="utf-8")
            selected = preflight_run(
                bundle, ROOT, run_id, run_dir, resume=True,
                environment=self.environment(), package_version="2.8.4", ray_available=True,
            )
            self.assertEqual(selected["protocol"]["runId"], run_id)
            (run_dir / "formal-run.json").write_text(json.dumps({"bundleHash": "sha256:wrong", "runId": run_id}), encoding="utf-8")
            with self.assertRaisesRegex(PreflightError, "does not match"):
                preflight_run(bundle, ROOT, run_id, run_dir, resume=True, environment=self.environment(), package_version="2.8.4", ray_available=True)

    def test_cli_help_is_ascii_safe_under_gbk_console(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONIOENCODING"] = "gbk"
        for module in ("execution.stage_bundle", "execution.run_formal"):
            completed = subprocess.run(
                [sys.executable, "-m", module, "--help"],
                cwd=ROOT,
                env=environment,
                text=True,
                capture_output=True,
                timeout=10,
                check=False,
            )
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertIn("AgentSociety2", completed.stdout)


if __name__ == "__main__":
    unittest.main()
