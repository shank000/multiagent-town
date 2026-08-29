from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
import importlib
from pathlib import Path
import sys
import tempfile
import types
import unittest


def install_sdk_surface_stub() -> None:
    """Expose only the documented AgentSociety² 2.8.4 API used by the adapter."""

    root = types.ModuleType("agentsociety2")
    env = types.ModuleType("agentsociety2.env")
    storage = types.ModuleType("agentsociety2.storage")
    workspace_state = types.ModuleType("agentsociety2.storage.workspace_state")

    class EnvBase:
        def __init__(self) -> None:
            self._replay_writer = None
            self._workspace_root: Path | None = None

        @property
        def name(self) -> str:
            return self.__class__.__name__

        def _bind_workspace(self, workspace_path) -> None:
            self._workspace_root = Path(workspace_path).resolve()
            self._workspace_root.mkdir(parents=True, exist_ok=True)

    def tool(**_metadata):
        return lambda function: function

    @dataclass
    class ColumnDef:
        name: str
        type: str
        nullable: bool = True
        logical_type: str | None = None

    @dataclass
    class TableSchema:
        name: str
        columns: list[ColumnDef]
        primary_key: list[str] = field(default_factory=list)
        indexes: list[list[str]] = field(default_factory=list)

    @dataclass
    class ReplayDatasetSpec:
        dataset_id: str
        table_name: str
        module_name: str
        kind: str
        title: str = ""
        entity_key: str | None = None
        step_key: str | None = None
        time_key: str | None = None
        default_order: list[str] = field(default_factory=list)
        capabilities: list[str] = field(default_factory=list)
        version: int = 1

    def atomic_write_text(path: Path, content: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    env.EnvBase = EnvBase
    env.tool = tool
    storage.ColumnDef = ColumnDef
    storage.TableSchema = TableSchema
    storage.ReplayDatasetSpec = ReplayDatasetSpec
    workspace_state.atomic_write_text = atomic_write_text
    sys.modules.update({
        "agentsociety2": root,
        "agentsociety2.env": env,
        "agentsociety2.storage": storage,
        "agentsociety2.storage.workspace_state": workspace_state,
    })


class FakeReplayWriter:
    def __init__(self) -> None:
        self.tables = []
        self.datasets = []
        self.rows = []

    async def register_table(self, schema) -> None:
        self.tables.append(schema)

    async def register_dataset(self, spec, columns) -> None:
        self.datasets.append((spec, columns))

    async def write(self, table_name, row) -> None:
        self.rows.append((table_name, row))


class PartnerChoiceEnvAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        install_sdk_surface_stub()
        cls.module = importlib.import_module("custom.envs.partner_choice_env")

    def test_parameterless_env_registers_four_datasets_and_writes_one_round(self) -> None:
        async def run() -> None:
            env = self.module.PartnerChoiceEnv()
            writer = FakeReplayWriter()
            env._replay_writer = writer
            await env.step(60, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
            for agent_id in (1, 2, 3):
                observation = await env.observe_partner_round(agent_id)
                self.assertTrue(observation["roundOpen"])
                chosen_id = int(observation["observation"]["candidates"][0]["id"])
                result = await env.submit_partner_choice(agent_id, chosen_id, "visible only")
                self.assertTrue(result["ok"])

            self.assertEqual(len(writer.tables), 4)
            self.assertEqual(
                {spec.dataset_id for spec, _ in writer.datasets},
                {
                    "partner_choice.choice_event",
                    "partner_choice.gift_event",
                    "partner_choice.interaction_event",
                    "partner_choice.relationship_state",
                },
            )
            choice_rows = [row for table, row in writer.rows if table == "partner_choice_choice_event"]
            self.assertEqual(len(choice_rows), 3)
            self.assertTrue(all(row["payload"]["historyMode"] == "none" for row in choice_rows))
            self.assertTrue(all(row["chooser_id"] is not None for row in choice_rows))
            choice_spec = next(spec for spec, _ in writer.datasets if spec.dataset_id == "partner_choice.choice_event")
            self.assertEqual(choice_spec.entity_key, "chooser_id")
            self.assertEqual(choice_spec.default_order, ["day", "round_id", "chooser_id", "event_seq"])
            for row in choice_rows:
                payload = row["payload"]
                self.assertEqual(payload["kind"], "experiment_pair_choice")
                self.assertEqual(payload["fromId"], payload["chooserId"])
                self.assertEqual(payload["toId"], payload["chosenId"])
                self.assertEqual(payload["chosen"], payload["chosenId"])

        asyncio.run(run())

    def test_workspace_roundtrip_restores_status_and_written_ids(self) -> None:
        async def run() -> None:
            env = self.module.PartnerChoiceEnv()
            writer = FakeReplayWriter()
            env._replay_writer = writer
            await env.step(60, datetime(2026, 1, 1, 19, 30, tzinfo=timezone.utc))
            observation = await env.observe_partner_round(1)
            chosen_id = int(observation["observation"]["candidates"][0]["id"])
            await env.submit_partner_choice(1, chosen_id)

            with tempfile.TemporaryDirectory() as tmp:
                await env.to_workspace(tmp)
                restored = self.module.PartnerChoiceEnv()
                self.assertTrue(await restored.restore(tmp))
                self.assertEqual(await restored.get_round_status(), await env.get_round_status())
                self.assertEqual(restored._core.written_event_ids, env._core.written_event_ids)

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
