"""Generate the paired 30-run protocol matrix from the frozen study manifest."""

from __future__ import annotations

from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_PATH = ROOT / "experiment-manifest.v1.json"
PROFILE_PATH = Path(__file__).resolve().parent / "profiles" / "cohort-24.json"
OUTPUT_PATH = Path(__file__).resolve().parent / "run-matrix.v1.json"


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def tagged_hash(value: Any) -> str:
    return "sha256:" + sha256(canonical_json(value).encode("utf-8")).hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def assigned_profiles(catalog: dict[str, Any], seed: int) -> list[dict[str, Any]]:
    profiles = deepcopy(catalog["profiles"])
    profiles.sort(
        key=lambda profile: sha256(
            canonical_json([seed, "profile_assignment", profile["profileId"]]).encode("utf-8")
        ).hexdigest()
    )
    return [
        {"agentId": str(index), **profile}
        for index, profile in enumerate(profiles, start=1)
    ]


def build_matrix() -> dict[str, Any]:
    manifest = load_json(MANIFEST_PATH)
    catalog = load_json(PROFILE_PATH)
    if len(catalog["profiles"]) != manifest["participantCount"]:
        raise ValueError("profile count must equal participantCount")
    conditions = [*manifest["coreConditions"], *manifest["robustnessConditions"]]
    blocks: list[dict[str, Any]] = []
    runs: list[dict[str, Any]] = []
    for replicate, seed in enumerate(manifest["seeds"], start=1):
        agents = assigned_profiles(catalog, seed)
        pairing_block_id = f"cohort24-seed-{seed}"
        profile_set_hash = tagged_hash(agents)
        blocks.append({
            "pairingBlockId": pairing_block_id,
            "replicate": replicate,
            "seed": seed,
            "profileSetHash": profile_set_hash,
            "agents": agents,
        })
        ordered_conditions = sorted(
            conditions,
            key=lambda condition: sha256(
                canonical_json([seed, "execution_order", condition["id"]]).encode("utf-8")
            ).hexdigest(),
        )
        for execution_order, condition in enumerate(ordered_conditions, start=1):
            manipulation = {
                "historyMode": condition["historyMode"],
                "giftExchange": condition["giftExchange"],
            }
            if "recentK" in condition:
                manipulation["recentK"] = condition["recentK"]
            protocol = {
                "schemaVersion": "partner-choice.protocol/v1",
                "studyId": "memory-access-partner-choice",
                "runId": f"{condition['id']}__seed-{seed}",
                "pairingBlockId": pairing_block_id,
                "conditionId": condition["id"],
                "replicate": replicate,
                "seed": seed,
                "agentIds": [agent["agentId"] for agent in agents],
                "profileSetHash": profile_set_hash,
                "days": manifest["days"],
                "roundMinute": manifest["roundMinute"],
                "manipulation": manipulation,
                "decision": deepcopy(manifest["decision"]),
            }
            runs.append({
                "executionOrder": execution_order,
                "protocolHash": tagged_hash(protocol),
                "protocol": protocol,
            })
    return {
        "schemaVersion": "partner-choice.run-matrix/v1",
        "studyManifestHash": tagged_hash(manifest),
        "profileCatalogHash": tagged_hash(catalog),
        "pairingBlocks": blocks,
        "runs": runs,
    }


def main() -> None:
    OUTPUT_PATH.write_text(
        json.dumps(build_matrix(), ensure_ascii=False, sort_keys=True, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
