"""Fail-closed preflight checks for formal AgentSociety² execution."""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from importlib.util import find_spec
import json
import os
from pathlib import Path
import sys
from typing import Any, Mapping
from urllib.parse import urlparse

from custom.partner_choice_core import protocol_hash, tagged_hash
from execution.stage_bundle import BUNDLE_SCHEMA, file_hash, load_frozen_sources, validate_model_id


class PreflightError(RuntimeError):
    """Raised before any run state is created when a formal hard gate fails."""


REQUIRED_ENV = (
    "AGENTSOCIETY_LLM_API_KEY",
    "AGENTSOCIETY_LLM_API_BASE",
    "AGENTSOCIETY_LLM_MODEL",
    "WORKSPACE_PATH",
)


def load_bundle(path: Path) -> dict[str, Any]:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise PreflightError("execution bundle must be a JSON object")
    return value


def _validate_bundle(bundle: Mapping[str, Any], workspace: Path) -> None:
    if bundle.get("schemaVersion") != BUNDLE_SCHEMA:
        raise PreflightError("execution bundle schema mismatch")
    expected_hash = tagged_hash({key: value for key, value in bundle.items() if key != "bundleHash"})
    if bundle.get("bundleHash") != expected_hash:
        raise PreflightError("execution bundle hash mismatch")
    validate_model_id(str(bundle.get("modelId") or ""))
    manifest, matrix, profiles = load_frozen_sources(workspace)
    expected_sources = {
        "manifestCanonical": tagged_hash(manifest),
        "manifestFile": file_hash(workspace / "experiment-manifest.v1.json"),
        "runMatrixCanonical": tagged_hash(matrix),
        "runMatrixFile": file_hash(workspace / "protocol" / "run-matrix.v1.json"),
        "profileCanonical": tagged_hash(profiles),
        "profileFile": file_hash(workspace / "protocol" / "profiles" / "cohort-24.json"),
    }
    if bundle.get("sourceHashes") != expected_sources:
        raise PreflightError("frozen manifest, matrix, or profile cohort changed after staging")
    runs = bundle.get("runs")
    if not isinstance(runs, list) or not runs:
        raise PreflightError("execution bundle contains no runs")
    run_ids: set[str] = set()
    for item in runs:
        protocol = item.get("protocol") if isinstance(item, Mapping) else None
        if not isinstance(protocol, Mapping):
            raise PreflightError("bundle run protocol is missing")
        run_id = str(protocol.get("runId") or "")
        if not run_id or run_id in run_ids:
            raise PreflightError("bundle run IDs must be non-empty and unique")
        run_ids.add(run_id)
        if protocol.get("decision", {}).get("modelId") != bundle["modelId"]:
            raise PreflightError(f"run {run_id} decision model differs from frozen bundle model")
        if protocol.get("interaction", {}).get("modelId") != bundle["modelId"]:
            raise PreflightError(f"run {run_id} interaction model differs from frozen bundle model")
        if item.get("stagedProtocolHash") != protocol_hash(protocol):
            raise PreflightError(f"run {run_id} staged protocol hash mismatch")


def _validate_environment(environment: Mapping[str, str], bundle: Mapping[str, Any], workspace: Path) -> None:
    missing = [name for name in REQUIRED_ENV if not str(environment.get(name) or "").strip()]
    if missing:
        raise PreflightError(f"missing critical environment configuration: {', '.join(missing)}")
    if environment["AGENTSOCIETY_LLM_MODEL"] != bundle["modelId"]:
        raise PreflightError("AGENTSOCIETY_LLM_MODEL differs from the frozen bundle model")
    parsed = urlparse(environment["AGENTSOCIETY_LLM_API_BASE"])
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise PreflightError("AGENTSOCIETY_LLM_API_BASE must be an absolute http(s) URL")
    if Path(environment["WORKSPACE_PATH"]).resolve() != workspace.resolve():
        raise PreflightError("WORKSPACE_PATH must point to the staged AgentSociety² workspace")


def _validate_runtime(package_version: str | None, python_version: tuple[int, int]) -> None:
    if package_version != "2.8.4":
        raise PreflightError(f"agentsociety2 package must be exactly 2.8.4, got {package_version!r}")
    if not ((3, 11) <= python_version < (3, 14)):
        raise PreflightError(f"Python must be >=3.11,<3.14, got {python_version[0]}.{python_version[1]}")


def preflight_run(
    bundle: Mapping[str, Any],
    workspace: Path,
    run_id: str,
    run_dir: Path,
    *,
    resume: bool = False,
    environment: Mapping[str, str] | None = None,
    package_version: str | None = None,
    python_version: tuple[int, int] | None = None,
    ray_available: bool | None = None,
) -> dict[str, Any]:
    """Validate all immutable/runtime gates without writing run state or secrets."""

    workspace = Path(workspace).resolve()
    run_dir = Path(run_dir).resolve()
    _validate_bundle(bundle, workspace)
    env = dict(os.environ if environment is None else environment)
    _validate_environment(env, bundle, workspace)
    if package_version is None:
        try:
            package_version = version("agentsociety2")
        except PackageNotFoundError:
            package_version = None
    _validate_runtime(package_version, python_version or sys.version_info[:2])
    if ray_available is None:
        ray_available = find_spec("ray") is not None
    if not ray_available:
        raise PreflightError("SDK_RAY_UNAVAILABLE: agentsociety2 lifecycle requires the ray module")
    selected = next((item for item in bundle["runs"] if item["protocol"]["runId"] == run_id), None)
    if selected is None:
        raise PreflightError(f"run id {run_id!r} is not present in the bundle")
    contents = list(run_dir.iterdir()) if run_dir.exists() else []
    if resume:
        if not run_dir.is_dir() or not contents:
            raise PreflightError("resume requires an existing non-empty run directory")
        metadata_path = run_dir / "formal-run.json"
        if not metadata_path.is_file():
            raise PreflightError("resume run directory is missing formal-run.json")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("bundleHash") != bundle["bundleHash"] or metadata.get("runId") != run_id:
            raise PreflightError("resume metadata does not match this bundle and run id")
        required = (run_dir / "protocol.json", run_dir / "SOCIETY.json", run_dir / "SOCIETY_STEP.json")
        missing_checkpoints = [path.name for path in required if not path.is_file()]
        if missing_checkpoints:
            raise PreflightError(f"resume run directory is incomplete: {', '.join(missing_checkpoints)}")
        saved_protocol = json.loads((run_dir / "protocol.json").read_text(encoding="utf-8"))
        if protocol_hash(saved_protocol) != selected["stagedProtocolHash"]:
            raise PreflightError("resume protocol.json differs from the staged protocol")
    elif contents:
        raise PreflightError("fresh execution refuses an existing non-empty run directory")
    return dict(selected)
