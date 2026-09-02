"""AgentSociety² 2.8.4 adapter for the partner-choice protocol.

The class is defined directly in custom/envs so the platform scanner can find
it. All scientific logic remains in the dependency-free core module.
"""

from __future__ import annotations

from datetime import datetime, timedelta
import json
import os
from pathlib import Path
from typing import Any

from agentsociety2.env import EnvBase, tool
from agentsociety2.storage import ColumnDef, ReplayDatasetSpec, ReplayReader, TableSchema
from agentsociety2.storage.workspace_state import atomic_write_text

from custom.partner_choice_core import PartnerChoiceCore, default_protocol


_STATE_REL = "state/ENV_STATE.json"
_FAULT_POINTS = {"after_replay_append", "after_written_set", "after_checkpoint_write"}


class InjectedCrash(RuntimeError):
    """Explicit fail-once crash used only by test/preflight recovery gates."""


class PartnerChoiceEnv(EnvBase):
    """Equal-candidate partner selection with condition-specific history visibility."""

    def __init__(
        self,
        protocol: dict[str, Any] | None = None,
        agent_id_name_pairs: list[list[Any]] | None = None,
        round_window_minutes: int = 60,
        replay_dir: str | None = None,
        fault_injection: str | None = None,
        execution_stage: str = "formal",
    ) -> None:
        super().__init__()
        chosen_protocol = protocol or default_protocol()
        names = {
            str(agent_id): str(name)
            for agent_id, name in (agent_id_name_pairs or [])
        }
        self._core = PartnerChoiceCore(
            chosen_protocol,
            names,
            round_window_minutes=round_window_minutes,
        )
        self._schemas_ready = False
        self._pending_replay: list[dict[str, Any]] = []
        self._replay_dir = Path(replay_dir).resolve() if replay_dir else None
        self._replay_reconciled = False
        self._fault_injection = fault_injection
        self._execution_stage = execution_stage
        if fault_injection is not None:
            if fault_injection not in _FAULT_POINTS:
                raise ValueError(f"unknown fault injection point: {fault_injection}")
            if os.environ.get("AGENTSOCIETY_ALLOW_FAULT_INJECTION") != "1":
                raise ValueError("fault injection requires AGENTSOCIETY_ALLOW_FAULT_INJECTION=1")
            if execution_stage not in {"test", "preflight", "online-smoke"}:
                raise ValueError("fault injection is forbidden outside test/preflight/smoke stages")

    @classmethod
    def mcp_description(cls) -> str:
        return (
            "PartnerChoiceEnv runs one equal-candidate partner-choice round per day. "
            "Agents observe the current candidate list, receive only the history allowed "
            "by the assigned condition, and submit exactly one validated choice."
        )

    @tool(readonly=True, kind="observe")
    async def observe_partner_round(self, agent_id: int) -> dict[str, Any]:
        """Return the current partner-choice observation for one participant."""

        return self._core.observe(str(agent_id))

    @tool(readonly=False)
    async def submit_partner_choice(
        self,
        agent_id: int,
        chosen_id: int,
        rationale: str = "",
        raw_response: str = "",
        model_id: str = "",
        request_id: str = "",
        rendered_prompt_hash: str = "",
        temperature: float = 0.0,
        top_p: float = 1.0,
        max_tokens: int = 0,
        attempt_count: int = 1,
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
        trace_id: str = "",
    ) -> dict[str, Any]:
        """Validate and idempotently record one participant's partner choice."""

        audit = None
        if request_id:
            audit = {
                "modelId": model_id,
                "requestId": request_id,
                "renderedPromptHash": rendered_prompt_hash,
                "rawResponse": raw_response,
                "temperature": temperature,
                "topP": top_p,
                "maxTokens": max_tokens,
                "attemptCount": attempt_count,
                "inputTokens": input_tokens,
                "outputTokens": output_tokens,
                "totalTokens": total_tokens,
                **({"traceId": trace_id} if trace_id else {}),
            }
        result = self._core.submit(
            str(agent_id),
            str(chosen_id),
            rationale[:1000],
            raw_response=raw_response[:4000] or None,
            attempt_count=attempt_count,
            decision_audit=audit,
            submitted_step=self._core.step_count,
            submitted_at=self.t,
        )
        await self._collect_and_flush()
        return result

    @tool(readonly=False)
    async def submit_interaction_summary(
        self,
        agent_id: int,
        summary: str,
        raw_response: str,
        model_id: str,
        request_id: str,
        rendered_prompt_hash: str,
        attempt_count: int,
        input_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int = 0,
        trace_id: str = "",
    ) -> dict[str, Any]:
        """Record an audited real-model interaction result for the chosen dyad."""

        audit = {
            "source": "llm",
            "modelId": model_id,
            "requestId": request_id,
            "renderedPromptHash": rendered_prompt_hash,
            "rawResponse": raw_response[:4000],
            "attemptCount": attempt_count,
            "inputTokens": input_tokens,
            "outputTokens": output_tokens,
            "totalTokens": total_tokens,
            **({"traceId": trace_id} if trace_id else {}),
        }
        result = self._core.submit_interaction(
            str(agent_id),
            summary[:1000],
            audit,
            submitted_step=self._core.step_count,
            submitted_at=self.t,
        )
        await self._collect_and_flush()
        return result

    @tool(readonly=True, kind="statistics")
    async def get_round_status(self) -> dict[str, Any]:
        """Return aggregate progress for the active partner round."""

        return self._core.round_status()

    async def step(self, tick: int, t: datetime) -> None:
        end_t = t + timedelta(seconds=tick)
        self.t = end_t
        self._core.advance(tick, end_t)
        await self._collect_and_flush()

    async def _collect_and_flush(self) -> None:
        self._pending_replay.extend(self._core.drain_events())
        writer = getattr(self, "_replay_writer", None)
        if writer is None:
            return
        await self._ensure_replay_schemas()
        self._reconcile_replay_ids()
        remaining: list[dict[str, Any]] = []
        for index, event in enumerate(self._pending_replay):
            event_id = str(event["eventId"])
            if event_id in self._core.written_event_ids:
                continue
            table_name = {
                "partner_choice": "partner_choice_choice_event",
                "gift": "partner_choice_gift_event",
                "interaction": "partner_choice_interaction_event",
                "relationship_state": "partner_choice_relationship_state",
            }.get(str(event["eventType"]))
            if table_name is None:
                remaining.append(event)
                continue
            row = self._replay_row(event)
            try:
                await writer.write(table_name, row)
                self._maybe_fail("after_replay_append")
                self._core.written_event_ids.add(event_id)
                self._maybe_fail("after_written_set")
            except Exception:
                remaining.append(event)
                remaining.extend(self._pending_replay[index + 1 :])
                self._pending_replay = remaining
                raise
        self._pending_replay = remaining

    def _reconcile_replay_ids(self) -> None:
        """Treat persisted Replay event IDs as authoritative after a crash."""

        if self._replay_reconciled or self._replay_dir is None or not self._replay_dir.exists():
            return
        reader = ReplayReader(self._replay_dir)
        try:
            for dataset in reader.load_dataset_catalog():
                if not str(dataset.get("dataset_id", "")).startswith("partner_choice."):
                    continue
                rows = reader.fetch_dataset_rows(dataset).get("rows", [])
                self._core.written_event_ids.update(
                    str(row["event_id"])
                    for row in rows
                    if row.get("event_id") is not None
                )
        finally:
            reader.close()
        self._replay_reconciled = True

    def _maybe_fail(self, point: str) -> None:
        if self._fault_injection != point:
            return
        if self._workspace_root is None:
            raise RuntimeError("fault injection requires a bound env workspace")
        marker = self._workspace_root / "state" / f"FAULT-{point}.triggered"
        if marker.exists():
            return
        atomic_write_text(marker, "fail-once\n")
        raise InjectedCrash(f"injected fail-once crash at {point}")

    @staticmethod
    def _replay_row(event: dict[str, Any]) -> dict[str, Any]:
        return {
            "event_id": event["eventId"],
            "schema_version": event["schemaVersion"],
            "run_id": event["runId"],
            "condition_id": event["conditionId"],
            "day": event["day"],
            "round_id": event["roundId"],
            "chooser_id": PartnerChoiceEnv._optional_id(event.get("chooserId")),
            "from_id": PartnerChoiceEnv._optional_id(event.get("fromId")),
            "to_id": PartnerChoiceEnv._optional_id(event.get("toId")),
            "agent_id": PartnerChoiceEnv._optional_id(event.get("agentId")),
            "partner_id": PartnerChoiceEnv._optional_id(event.get("partnerId")),
            "relation_id": PartnerChoiceEnv._optional_id(event.get("relationId")),
            "event_seq": event["eventSeq"],
            "step": event["step"],
            "t": event["t"],
            "payload": event,
        }

    @staticmethod
    def _optional_id(value: Any) -> str | None:
        return None if value is None else str(value)

    async def _ensure_replay_schemas(self) -> None:
        if self._schemas_ready:
            return
        writer = getattr(self, "_replay_writer", None)
        if writer is None:
            return
        common = [
            ColumnDef("event_id", "TEXT", nullable=False, logical_type="identifier"),
            ColumnDef("schema_version", "TEXT", nullable=False),
            ColumnDef("run_id", "TEXT", nullable=False, logical_type="identifier"),
            ColumnDef("condition_id", "TEXT", nullable=False),
            ColumnDef("day", "INTEGER", nullable=False),
            ColumnDef("round_id", "TEXT", nullable=False, logical_type="identifier"),
            ColumnDef("chooser_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("from_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("to_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("agent_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("partner_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("relation_id", "TEXT", nullable=True, logical_type="identifier"),
            ColumnDef("event_seq", "INTEGER", nullable=False),
            ColumnDef("step", "INTEGER", nullable=False, logical_type="step"),
            ColumnDef("t", "TIMESTAMP", nullable=False, logical_type="timestamp"),
            ColumnDef("payload", "JSON", nullable=False),
        ]
        definitions = [
            (
                "partner_choice.choice_event",
                "partner_choice_choice_event",
                "Partner choices with exact observations, model outputs, and audit state",
                "event_stream",
                ["partner_choice", "event_stream"],
                "chooser_id",
            ),
            (
                "partner_choice.gift_event",
                "partner_choice_gift_event",
                "Post-choice gift treatment events",
                "event_stream",
                ["gift", "event_stream"],
                "from_id",
            ),
            (
                "partner_choice.interaction_event",
                "partner_choice_interaction_event",
                "Partner interaction completion events",
                "event_stream",
                ["interaction", "event_stream"],
                "from_id",
            ),
            (
                "partner_choice.relationship_state",
                "partner_choice_relationship_state",
                "Directed relationship state after each partner round",
                "entity_snapshot",
                ["agent_snapshot", "timeseries", "relationship"],
                "relation_id",
            ),
        ]
        for dataset_id, table_name, title, kind, capabilities, entity_key in definitions:
            schema = TableSchema(
                name=table_name,
                columns=common,
                primary_key=["event_id"],
                indexes=[["run_id", "day"], [entity_key], ["round_id"]],
            )
            await writer.register_table(schema)
            await writer.register_dataset(
                ReplayDatasetSpec(
                    dataset_id=dataset_id,
                    table_name=table_name,
                    module_name=self.name,
                    kind=kind,
                    title=title,
                    entity_key=entity_key,
                    step_key="step",
                    time_key="t",
                    default_order=["day", "round_id", entity_key, "event_seq"],
                    capabilities=capabilities,
                    version=1,
                ),
                schema.columns,
            )
        self._schemas_ready = True

    async def to_workspace(self, workspace_path: Path | str | None = None) -> None:
        if workspace_path is not None:
            self._bind_workspace(workspace_path)
        state = self._core.to_state()
        state["adapterPendingReplay"] = self._pending_replay
        atomic_write_text(
            self._workspace_root / _STATE_REL,
            json.dumps(state, ensure_ascii=False, sort_keys=True, indent=2),
        )
        self._maybe_fail("after_checkpoint_write")

    async def restore(self, workspace_path: Path | str) -> bool:
        self._bind_workspace(workspace_path)
        state_path = self._workspace_root / _STATE_REL
        if not state_path.is_file():
            return False
        state = json.loads(state_path.read_text(encoding="utf-8"))
        self._core = PartnerChoiceCore.from_state(state)
        if self._core.current_round is not None:
            self._core.current_round.setdefault("interactionSubmissions", {})
        self._pending_replay = list(state.get("adapterPendingReplay", []))
        self._schemas_ready = False
        self._replay_reconciled = False
        self._reconcile_replay_ids()
        return True
