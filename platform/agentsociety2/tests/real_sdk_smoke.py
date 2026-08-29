"""Offline smoke gate against the pinned AgentSociety SDK and ReplayReader."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile

os.environ.setdefault("AGENTSOCIETY_LLM_API_KEY", "offline-contract-smoke")
os.environ.setdefault("WORKSPACE_PATH", str(Path(__file__).resolve().parents[1]))

from agentsociety2.storage import ReplayReader, ReplayWriter
from agentsociety2.backend.services.custom.scanner import CustomModuleScanner

from custom.envs.partner_choice_env import PartnerChoiceEnv
from custom.agents.partner_choice_agent import PartnerChoiceAgent


async def run() -> None:
    workspace_root = Path(__file__).resolve().parents[1]
    scan = CustomModuleScanner(str(workspace_root)).scan_all()
    assert scan["errors"] == []
    accepted_envs = [item for item in scan["envs"] if item["type"] == "PartnerChoiceEnv"]
    assert len(accepted_envs) == 1
    accepted_agents = [item for item in scan["agents"] if item["type"] == "PartnerChoiceAgent"]
    assert len(accepted_agents) == 1

    prompt = PartnerChoiceAgent._decision_messages(
        {"id": 1, "name": "Participant 01"},
        {"schemaVersion": "partner-choice.observation/v1", "day": 1, "roundId": "day-001-1930", "chooserId": "1", "candidates": []},
    )
    rendered = str(prompt)
    assert "conditionId" not in rendered and "historyMode" not in rendered and "giftExchange" not in rendered

    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        replay_dir = root / "replay"
        workspace_dir = root / "workspace"
        writer = ReplayWriter(replay_dir)
        env = PartnerChoiceEnv()
        env.set_replay_writer(writer)

        await env.step(60, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        for agent_id in (1, 2, 3):
            observed = await env.observe_partner_round(agent_id)
            chosen_id = int(observed["observation"]["candidates"][0]["id"])
            result = await env.submit_partner_choice(
                agent_id,
                chosen_id,
                rationale="decision from the protocol observation",
            )
            assert result["ok"]

        await env.to_workspace(workspace_dir)
        await writer.close()

        reader = ReplayReader(replay_dir)
        try:
            catalog = reader.load_dataset_catalog()
            ids = {dataset["dataset_id"] for dataset in catalog}
            assert ids == {
                "partner_choice.choice_event",
                "partner_choice.gift_event",
                "partner_choice.interaction_event",
                "partner_choice.relationship_state",
            }
            choices = reader.get_dataset_by_id("partner_choice.choice_event")
            assert choices["entity_key"] == "chooser_id"
            assert choices["default_order"] == [
                "day",
                "round_id",
                "chooser_id",
                "event_seq",
            ]
            result = reader.fetch_dataset_rows(choices)
            assert len(result["rows"]) == 3
            assert all(row["payload"]["decision"]["source"] == "tool_submission" for row in result["rows"])
            relationships = reader.get_dataset_by_id("partner_choice.relationship_state")
            assert relationships["entity_key"] == "relation_id"
        finally:
            reader.close()

        restored = PartnerChoiceEnv()
        assert await restored.restore(workspace_dir)
        assert await restored.get_round_status() == await env.get_round_status()


if __name__ == "__main__":
    asyncio.run(run())
    print("AgentSociety 2.8.4 SDK/Replay/checkpoint smoke: ok")
