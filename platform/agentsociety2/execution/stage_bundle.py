"""Create deterministic execution bundles from the frozen study artifacts.

The source manifest and run matrix are inputs only.  Development stages derive
shorter protocols in the bundle while retaining hashes of every frozen source.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from typing import Any, Mapping

from custom.partner_choice_core import canonical_json, protocol_hash, tagged_hash


BUNDLE_SCHEMA = "partner-choice.execution-bundle/v1"
PLACEHOLDER_MODEL_IDS = {
    "ONLINE_WORKSPACE_REQUIRED",
    "offline-contract-model",
    "placeholder",
    "mock",
}
STAGES = ("online-smoke", "capacity", "preflight", "main", "robustness")


class StageError(ValueError):
    """Raised when frozen sources or stage arguments are unsafe."""


def file_hash(path: Path) -> str:
    return "sha256:" + sha256(path.read_bytes()).hexdigest()


def validate_model_id(model_id: str) -> str:
    value = str(model_id).strip()
    if not value or value in PLACEHOLDER_MODEL_IDS or "PLACEHOLDER" in value.upper():
        raise StageError("model id must be the actual frozen online model, not a placeholder")
    return value


def load_frozen_sources(root: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    manifest_path = root / "experiment-manifest.v1.json"
    matrix_path = root / "protocol" / "run-matrix.v1.json"
    profiles_path = root / "protocol" / "profiles" / "cohort-24.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    matrix = json.loads(matrix_path.read_text(encoding="utf-8"))
    profiles = json.loads(profiles_path.read_text(encoding="utf-8"))
    if manifest.get("platform") != {
        "package": "agentsociety2",
        "version": "2.8.4",
        "python": ">=3.11,<3.14",
    }:
        raise StageError("frozen manifest platform contract changed")
    if matrix.get("studyManifestHash") != tagged_hash(manifest):
        raise StageError("run matrix studyManifestHash does not match frozen manifest")
    if matrix.get("profileCatalogHash") != tagged_hash(profiles):
        raise StageError("run matrix profileCatalogHash does not match frozen cohort")
    return manifest, matrix, profiles


def _stage_selection(stage: str, runs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    core = [item for item in runs if item["protocol"]["manipulation"]["historyMode"] in {"none", "full"}]
    recent = [item for item in runs if item["protocol"]["manipulation"]["historyMode"] == "recent_k"]
    if stage == "online-smoke":
        return [next(item for item in core if item["protocol"]["seed"] == 101 and item["protocol"]["conditionId"] == "memory-full__gift-off")]
    if stage in {"capacity", "preflight"}:
        return [item for item in core if item["protocol"]["seed"] == 101]
    if stage == "main":
        return core
    if stage == "robustness":
        return recent
    raise StageError(f"unknown stage {stage!r}")


def _profiles_by_seed(matrix: Mapping[str, Any]) -> dict[int, list[dict[str, Any]]]:
    return {
        int(block["seed"]): deepcopy(block["agents"])
        for block in matrix["pairingBlocks"]
    }


def build_execution_bundle(root: Path, stage: str, model_id: str) -> dict[str, Any]:
    """Return one deterministic, credential-free bundle for a named stage."""

    root = Path(root).resolve()
    if stage not in STAGES:
        raise StageError(f"stage must be one of {', '.join(STAGES)}")
    frozen_model = validate_model_id(model_id)
    manifest, matrix, profiles = load_frozen_sources(root)
    profiles_by_seed = _profiles_by_seed(matrix)
    selected = _stage_selection(stage, list(matrix["runs"]))
    derived_days = {"online-smoke": 1, "capacity": 2, "preflight": 5}.get(stage)
    run_items: list[dict[str, Any]] = []
    for source in selected:
        protocol = deepcopy(source["protocol"])
        protocol["decision"]["modelId"] = frozen_model
        protocol["interaction"] = {
            "policy": "llm_audited",
            "modelId": frozen_model,
            "promptVersion": "partner-choice.interaction/v1",
            "maxTokens": 192,
            "maxAttempts": 2,
        }
        if derived_days is not None:
            protocol["days"] = derived_days
            protocol["runId"] = f"{source['protocol']['runId']}__{stage}"
        agents = deepcopy(profiles_by_seed[int(protocol["seed"])])
        if stage == "online-smoke":
            agents = agents[:2]
            protocol["agentIds"] = [str(item["agentId"]) for item in agents]
            protocol["profileSetHash"] = tagged_hash(agents)
        run_items.append({
            "executionOrder": int(source["executionOrder"]),
            "sourceProtocolHash": str(source["protocolHash"]),
            "stagedProtocolHash": protocol_hash(protocol),
            "protocol": protocol,
            "agents": agents,
        })
    run_items.sort(key=lambda item: (int(item["protocol"]["seed"]), int(item["executionOrder"])))
    bundle = {
        "schemaVersion": BUNDLE_SCHEMA,
        "stage": stage,
        "platform": deepcopy(manifest["platform"]),
        "modelId": frozen_model,
        "sourceHashes": {
            "manifestCanonical": tagged_hash(manifest),
            "manifestFile": file_hash(root / "experiment-manifest.v1.json"),
            "runMatrixCanonical": tagged_hash(matrix),
            "runMatrixFile": file_hash(root / "protocol" / "run-matrix.v1.json"),
            "profileCanonical": tagged_hash(profiles),
            "profileFile": file_hash(root / "protocol" / "profiles" / "cohort-24.json"),
        },
        "seedBlockExecutionOrder": [
            {
                "seed": seed,
                "runIds": [item["protocol"]["runId"] for item in run_items if int(item["protocol"]["seed"]) == seed],
            }
            for seed in sorted({int(item["protocol"]["seed"]) for item in run_items})
        ],
        "analysisUnit": {
            "independent": "condition_by_seed_world_run",
            "nestedRepeatedMeasurements": ["day", "agent", "dyad"],
            "confirmatoryEstimand": "day31_60_directed_edge_repeat_rate",
            "pairedSeedCount": 5,
            "minimumTwoSidedExactP": 0.0625,
        },
        "runs": run_items,
    }
    bundle["bundleHash"] = tagged_hash(bundle)
    return bundle


def write_bundle(bundle: Mapping[str, Any], output: Path) -> None:
    output = Path(output).resolve()
    if output.exists():
        raise StageError(f"refusing to overwrite existing bundle: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.name}.tmp")
    temporary.write_text(json.dumps(bundle, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    temporary.replace(output)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stage a deterministic AgentSociety2 execution bundle")
    parser.add_argument("--stage", required=True, choices=STAGES)
    parser.add_argument("--model-id", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--workspace", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    bundle = build_execution_bundle(args.workspace, args.stage, args.model_id)
    write_bundle(bundle, args.output)
    print(canonical_json({"bundleHash": bundle["bundleHash"], "runs": len(bundle["runs"]), "stage": bundle["stage"]}))


if __name__ == "__main__":
    main()
