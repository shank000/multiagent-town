"""Subprocess helper exercising actual AgentSociety Replay storage."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import tempfile

os.environ.setdefault("AGENTSOCIETY_LLM_API_KEY", "offline-replay-gate")
os.environ["AGENTSOCIETY_ALLOW_FAULT_INJECTION"] = "1"

from agentsociety2.storage import ReplayReader, ReplayWriter

from custom.envs.partner_choice_env import InjectedCrash, PartnerChoiceEnv


async def scenario(point: str) -> dict[str, int | str]:
    with tempfile.TemporaryDirectory() as temporary:
        root = Path(temporary)
        replay = root / "replay"
        workspace = root / "workspace"
        writer = ReplayWriter(replay)
        env = PartnerChoiceEnv(replay_dir=str(replay), execution_stage="test")
        env._bind_workspace(workspace)
        env.set_replay_writer(writer)
        await env.step(60, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
        await env.to_workspace()
        env._fault_injection = point
        observed = await env.observe_partner_round(1)
        chosen = int(observed["observation"]["candidates"][0]["id"])
        crashed = False
        try:
            await env.submit_partner_choice(1, chosen)
            if point == "after_checkpoint_write":
                await env.to_workspace()
        except InjectedCrash:
            crashed = True
        assert crashed, point
        await writer.close()

        resumed_writer = ReplayWriter(replay)
        resumed = PartnerChoiceEnv(
            replay_dir=str(replay), fault_injection=point, execution_stage="test"
        )
        resumed.set_replay_writer(resumed_writer)
        assert await resumed.restore(workspace)
        resumed.t = datetime(2026, 1, 1, 19, 31, tzinfo=timezone.utc)
        observation = await resumed.observe_partner_round(1)
        if observation.get("roundOpen") and not observation.get("alreadySubmitted"):
            result = await resumed.submit_partner_choice(1, chosen)
            assert result["ok"]
        for agent_id in (2, 3):
            observation = await resumed.observe_partner_round(agent_id)
            selected = int(observation["observation"]["candidates"][0]["id"])
            result = await resumed.submit_partner_choice(agent_id, selected)
            assert result["ok"]
        await resumed.to_workspace()
        await resumed_writer.close()

        reader = ReplayReader(replay)
        try:
            rows = []
            for dataset in reader.load_dataset_catalog():
                if str(dataset["dataset_id"]).startswith("partner_choice."):
                    rows.extend(reader.fetch_dataset_rows(dataset)["rows"])
        finally:
            reader.close()
        event_ids = [str(row["event_id"]) for row in rows]
        assert len(event_ids) == 12, (point, event_ids)
        assert len(set(event_ids)) == len(event_ids)
        return {"point": point, "rows": len(event_ids), "unique": len(set(event_ids))}


async def main() -> None:
    results = [
        await scenario(point)
        for point in ("after_replay_append", "after_written_set", "after_checkpoint_write")
    ]
    print(json.dumps(results, sort_keys=True))


if __name__ == "__main__":
    asyncio.run(main())
