"""Execute one staged run through the real AgentSociety² lifecycle."""

from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
from time import perf_counter
from typing import Any, Mapping

from analysis.validate_run import load_replay_events
from execution.preflight import load_bundle, preflight_run
from execution.quality import build_quality_report, write_quality_report


RUN_METADATA_SCHEMA = "partner-choice.formal-run/v1"


def atomic_write_text(path: Path, content: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(content, encoding="utf-8")
    temporary.replace(path)


def build_agent_specs(run: Mapping[str, Any]) -> list[dict[str, Any]]:
    protocol = run["protocol"]
    specs = []
    for item in run["agents"]:
        profile = dict(item)
        profile["id"] = int(item["agentId"])
        profile["name"] = str(item["displayName"])
        specs.append({
            "id": int(item["agentId"]),
            "profile": profile,
            "config": {
                "decision": dict(protocol["decision"]),
                "interaction": dict(protocol["interaction"]),
                "enable_todo_list": False,
                "max_react_turns": 1,
            },
        })
    return specs


async def drive_daily_clock(society: Any, protocol: Mapping[str, Any]) -> None:
    """Advance the explicit UTC clock through each decision and deadline.

    The environment lives in a Ray actor, so the driver intentionally does not
    reach into its private state.  Resume is determined solely from the SDK's
    restored ``current_time``.  Replay validation is the authoritative proof
    that every scheduled round closed.
    """

    start = datetime(2026, 1, 1, tzinfo=timezone.utc)
    days = int(protocol["days"])
    round_minute = int(protocol["roundMinute"])
    window_seconds = 60 * 60
    for day in range(1, days + 1):
        target = start + timedelta(minutes=(day - 1) * 1440 + round_minute)
        deadline = target + timedelta(seconds=window_seconds)
        if society.current_time >= deadline:
            continue
        if society.current_time < target:
            await society.step(int((target - society.current_time).total_seconds()))
        if society.current_time < deadline:
            await society.step(min(60, int((deadline - society.current_time).total_seconds())))
        if society.current_time < deadline:
            await society.step(int((deadline - society.current_time).total_seconds()))


async def execute_selected_run(
    bundle: Mapping[str, Any],
    selected: Mapping[str, Any],
    workspace: Path,
    run_dir: Path,
    *,
    resume: bool = False,
    fault_injection: str | None = None,
) -> dict[str, Any]:
    """Construct custom modules, call AgentSociety init/step/close, and report."""

    from agentsociety2.agent.service_proxy import build_service_proxy
    from agentsociety2.config.llm_dispatcher import build_client_for_role
    from agentsociety2.env.env_router_actor import get_env_router_actor_class
    from agentsociety2.env.env_router_proxy import EnvRouterProxy
    from agentsociety2.registry import scan_and_register_custom_modules
    from agentsociety2.society import AgentSociety
    from agentsociety2.storage.replay_proxy import ReplayProxy
    from agentsociety2.trace import TraceProxy

    workspace = Path(workspace).resolve()
    run_dir = Path(run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)
    protocol = selected["protocol"]
    metadata = {
        "schemaVersion": RUN_METADATA_SCHEMA,
        "bundleHash": bundle["bundleHash"],
        "runId": protocol["runId"],
        "stage": bundle["stage"],
        "modelId": bundle["modelId"],
        "stagedProtocolHash": selected["stagedProtocolHash"],
    }
    if not resume:
        atomic_write_text(run_dir / "formal-run.json", json.dumps(metadata, ensure_ascii=False, sort_keys=True, indent=2))
        atomic_write_text(run_dir / "protocol.json", json.dumps(protocol, ensure_ascii=False, sort_keys=True, indent=2))

    scan = scan_and_register_custom_modules(workspace)
    if scan.get("errors"):
        raise RuntimeError(f"custom module scan failed: {scan['errors']}")
    replay_dir = run_dir / "replay"
    replay = ReplayProxy(replay_dir=str(replay_dir), enabled=True)
    trace = TraceProxy(trace_dir=str(run_dir / "trace"))
    env_kwargs = {
        "PartnerChoiceEnv": {
            "protocol": dict(protocol),
            "agent_id_name_pairs": [
                [int(item["agentId"]), item["displayName"]]
                for item in selected["agents"]
            ],
            "round_window_minutes": 60,
            "replay_dir": str(replay_dir),
            "fault_injection": fault_injection,
            "execution_stage": str(bundle["stage"]),
        }
    }
    llm_clients_spec = {
        "coder": build_client_for_role("coder"),
        "default": build_client_for_role("default"),
    }
    actor_cls = get_env_router_actor_class(max_concurrency=1)
    env_actor = actor_cls.remote(
        ["PartnerChoiceEnv"],
        env_kwargs,
        str(run_dir),
        {
            "max_steps": 2,
            "max_llm_call_retry": 1,
            "final_summary_enabled": False,
            "code_format": "raw_code",
            # Formal calls must not depend on a mutable cross-run semantic
            # cache or an un-frozen embedding endpoint.
            "template_cache_enabled": False,
            "template_cache_dir": str(run_dir / "env-template-cache"),
        },
        llm_clients_spec,
        replay,
        trace,
    )
    env_router = EnvRouterProxy(
        env_actor,
        run_dir=run_dir,
        env_module_types=["PartnerChoiceEnv"],
    )
    service = build_service_proxy(env_router, run_dir=run_dir, trace=trace, replay=replay)
    if resume:
        society = await AgentSociety.from_workspace(run_dir, env_router=env_router, service_proxy=service)
    else:
        society = AgentSociety(
            agent_specs=build_agent_specs(selected),
            agent_class_name="PartnerChoiceAgent",
            env_router=env_router,
            start_t=datetime(2026, 1, 1, tzinfo=timezone.utc),
            run_dir=run_dir,
            service_proxy=service,
            batch_size=len(selected["agents"]),
            enable_replay=True,
            env_module_types=["PartnerChoiceEnv"],
            env_kwargs=env_kwargs,
        )
    started = perf_counter()
    runtime_errors: list[str] = []
    token_stats: dict[str, Any] = {}
    try:
        await society.init()
        await drive_daily_clock(society, protocol)
        await society.to_workspace()
        token_stats = dict(getattr(society, "_token_stats", {}) or {})
    except Exception as exc:
        runtime_errors.append(f"runtime: {type(exc).__name__}: {exc}")
    finally:
        try:
            await society.close()
        except Exception as exc:
            runtime_errors.append(f"close: {type(exc).__name__}: {exc}")
    elapsed = (perf_counter() - started) * 1000
    try:
        events = load_replay_events(replay_dir)
    except Exception as exc:
        events = []
        runtime_errors.append(f"replay_read: {type(exc).__name__}: {exc}")
    report = build_quality_report(
        protocol,
        events,
        duration_ms=elapsed,
        replay_dir=replay_dir,
        checkpoint_dir=run_dir,
        sdk_token_stats=token_stats,
        runtime_errors=runtime_errors,
    )
    write_quality_report(report, run_dir / "quality-report.json")
    return report


async def async_main(args: argparse.Namespace) -> int:
    workspace = Path(args.workspace).resolve()
    bundle = load_bundle(args.bundle)
    selected = preflight_run(bundle, workspace, args.run_id, args.run_dir, resume=args.resume)
    report = await execute_selected_run(
        bundle, selected, workspace, args.run_dir,
        resume=args.resume, fault_injection=args.fault_injection,
    )
    print(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2))
    return 0 if report["formalGatePassed"] else 1


def main() -> None:
    parser = argparse.ArgumentParser(description="Run one frozen AgentSociety2 condition-by-seed world")
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-dir", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--fault-injection", choices=("after_replay_append", "after_written_set", "after_checkpoint_write"))
    args = parser.parse_args()
    raise SystemExit(asyncio.run(async_main(args)))


if __name__ == "__main__":
    main()
