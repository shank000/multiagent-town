from __future__ import annotations

from datetime import datetime, timedelta, timezone
import unittest

from custom.partner_choice_core import PartnerChoiceCore, default_protocol
from execution.run_formal import build_agent_specs, drive_daily_clock
from execution.stage_bundle import build_execution_bundle
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class FakeEnv:
    def __init__(self, protocol: dict) -> None:
        self._core = PartnerChoiceCore(protocol, round_window_minutes=30)


class ControlledSociety:
    """Lifecycle double; model absence intentionally exercises audited fallback."""

    def __init__(self, env: FakeEnv) -> None:
        self.env = env
        self.current_time = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.calls: list[tuple[str, int | None]] = []

    async def init(self) -> None:
        self.calls.append(("init", None))

    async def step(self, tick: int) -> None:
        self.calls.append(("step", tick))
        self.current_time += timedelta(seconds=tick)
        self.env._core.advance(tick, self.current_time)

    async def to_workspace(self) -> None:
        self.calls.append(("checkpoint", None))

    async def close(self) -> None:
        self.calls.append(("close", None))


class FormalLifecycleTest(unittest.TestCase):
    def test_agent_specs_come_only_from_frozen_profile_cohort(self) -> None:
        bundle = build_execution_bundle(ROOT, "online-smoke", "online/formal-model-v1")
        specs = build_agent_specs(bundle["runs"][0])
        self.assertEqual(len(specs), 2)
        self.assertEqual([spec["id"] for spec in specs], [1, 2])
        self.assertTrue(all(spec["config"]["decision"]["modelId"] == bundle["modelId"] for spec in specs))
        self.assertTrue(all(spec["config"]["interaction"]["modelId"] == bundle["modelId"] for spec in specs))

    def test_explicit_daily_clock_reaches_terminal_fallback_without_skipping(self) -> None:
        protocol = default_protocol()
        protocol["days"] = 2
        protocol["decision"]["modelId"] = "online/formal-model-v1"
        protocol["interaction"] = {
            "policy": "llm_audited", "modelId": "online/formal-model-v1",
            "promptVersion": "partner-choice.interaction/v1", "maxTokens": 192, "maxAttempts": 2,
        }
        env = FakeEnv(protocol)
        society = ControlledSociety(env)

        async def run() -> None:
            await society.init()
            try:
                await drive_daily_clock(society, protocol)
                await society.to_workspace()
            finally:
                await society.close()

        import asyncio
        asyncio.run(run())
        self.assertEqual(env._core.round_status()["status"], "closed")
        self.assertEqual(env._core.round_status()["day"], 2)
        self.assertEqual(society.calls[0][0], "init")
        self.assertEqual(society.calls[-1][0], "close")
        self.assertEqual(sum(1 for name, _ in society.calls if name == "checkpoint"), 1)
        interactions = [event for event in env._core.drain_events() if event["eventType"] == "interaction"]
        self.assertEqual(len(interactions), 2 * len(protocol["agentIds"]))
        self.assertTrue(all(event["summaryDecision"]["source"] == "deterministic_fallback" for event in interactions))


if __name__ == "__main__":
    unittest.main()
