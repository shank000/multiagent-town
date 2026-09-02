from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RealSdkLifecycleTest(unittest.TestCase):
    def test_actual_agent_society_lifecycle_or_explicit_ray_hard_gate(self) -> None:
        environment = dict(os.environ)
        environment["PYTHONPATH"] = str(ROOT)
        completed = subprocess.run(
            [sys.executable, str(ROOT / "tests" / "sdk_lifecycle_fixture.py")],
            cwd=ROOT,
            env=environment,
            text=True,
            capture_output=True,
            timeout=180,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        result = json.loads(completed.stdout.strip().splitlines()[-1])
        if result.get("hardGate") == "SDK_RAY_UNAVAILABLE":
            self.assertFalse(result["formalGatePassed"])
            self.assertEqual((result["choices"], result["interactions"]), (0, 0))
            self.assertEqual(result["httpRequests"], 0)
        else:
            self.assertTrue(result["formalGatePassed"])
            self.assertEqual((result["choices"], result["interactions"]), (2, 2))
            self.assertGreaterEqual(result["httpRequests"], 4)
            self.assertGreater(result["replayBytes"], 0)


if __name__ == "__main__":
    unittest.main()
