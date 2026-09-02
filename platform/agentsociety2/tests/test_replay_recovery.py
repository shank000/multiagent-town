from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ReplayRecoveryTest(unittest.TestCase):
    def test_actual_replay_is_exactly_once_at_all_three_fault_points(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(ROOT)
        environment.setdefault("AGENTSOCIETY_LLM_API_KEY", "offline-replay-gate")
        completed = subprocess.run(
            [sys.executable, str(ROOT / "tests" / "replay_fault_scenario.py")],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            timeout=60,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        results = json.loads(completed.stdout.strip().splitlines()[-1])
        self.assertEqual(
            {item["point"] for item in results},
            {"after_replay_append", "after_written_set", "after_checkpoint_write"},
        )
        self.assertTrue(all(item["rows"] == item["unique"] == 12 for item in results))


if __name__ == "__main__":
    unittest.main()
