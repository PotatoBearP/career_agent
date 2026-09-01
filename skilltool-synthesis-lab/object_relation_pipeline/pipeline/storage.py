from __future__ import annotations

import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .contracts import STAGE_ORDER, StageExecution
from .contexts import normalize_context_inputs


RUN_ID_PATTERN = re.compile(r"^orun-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
P0_DEFAULTS = {
    "target_count": 24,
    "candidate_multiplier": 2,
    "min_tasks_per_binding": 1,
    "cross_scenario_ratio": 0.3,
    "max_bindings": 16,
    "bridge_tasks_per_group": 2,
    "max_bridge_candidates": 32,
    "max_bridge_groups": 8,
    "hard_min_m": 1,
    "hard_min_n": 1,
    "preferred_min_m": 2,
    "min_complexity_score": 0.65,
    "allow_cross_profile_tasks": False,
}


def json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, indent=2) + "\n"


def write_value(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(value, str):
        path.write_text(value, encoding="utf-8")
    else:
        path.write_text(json_text(value), encoding="utf-8")


def atomic_write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json_text(value), encoding="utf-8")
    temporary.replace(path)


def new_run_id(model_name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", model_name.lower()).strip("-")[:40] or "model"
    return f"orun-{time.strftime('%Y%m%d-%H%M%S')}-{slug}-{uuid.uuid4().hex[:8]}"


def validate_run_id(run_id: str) -> None:
    if not RUN_ID_PATTERN.fullmatch(run_id):
        raise ValueError("invalid object-relation run id")


def create_state(
    *,
    run_id: str,
    profile: str | None = None,
    scenario: str | None = None,
    profiles: list[dict[str, Any] | str] | None = None,
    scenarios: list[dict[str, Any] | str] | None = None,
    bindings: list[dict[str, Any]] | None = None,
    model_mode: str,
    model_name: str,
    options: dict[str, Any],
) -> dict[str, Any]:
    validate_run_id(run_id)
    options = dict(options or {})
    p0_options = {**P0_DEFAULTS, **dict(options.get("p0") or {})}
    options["p0"] = p0_options
    normalized_inputs = normalize_context_inputs(
        profile=profile,
        scenario=scenario,
        profiles=profiles,
        scenarios=scenarios,
        bindings=bindings,
        max_bindings=int(p0_options["max_bindings"]),
    )
    return {
        "schema_version": "object-relation-pipeline.v2",
        "run_id": run_id,
        "run_status": "in_progress",
        "model_mode": model_mode,
        "model_name": model_name,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "inputs": normalized_inputs,
        "options": options,
        "stage_order": list(STAGE_ORDER),
        "completed_stages": [],
        "next_stage": STAGE_ORDER[0],
        "stage_results": {},
        "summary": {
            "p0_tasks": 0,
            "p0_candidates": 0,
            "p0_complexity_passed": 0,
            "latent_relations": 0,
            "canonical_objects": 0,
            "sampled_relations": 0,
            "p1_candidates": 0,
            "p1_tasks": 0,
            "skills": 0,
        },
    }


def load_state(runs_root: Path, run_id: str) -> dict[str, Any]:
    validate_run_id(run_id)
    path = runs_root / run_id / "run.json"
    if not path.is_file():
        raise FileNotFoundError(run_id)
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("run_id") != run_id:
        raise ValueError("stored run id does not match directory")
    _migrate_legacy_state(state)
    return state


def _migrate_legacy_state(state: dict[str, Any]) -> None:
    """Keep pre-v2 runs inspectable and resumable without re-running paid model stages."""
    inputs = state.get("inputs") or {}
    if not inputs.get("profiles") or not inputs.get("scenarios") or not inputs.get("bindings"):
        state["inputs"] = normalize_context_inputs(
            profile=str(inputs.get("profile") or ""),
            scenario=str(inputs.get("scenario") or ""),
            max_bindings=int(P0_DEFAULTS["max_bindings"]),
        )
    state.setdefault("options", {})["p0"] = {
        **P0_DEFAULTS,
        **dict((state.get("options") or {}).get("p0") or {}),
    }
    completed = list(state.get("completed_stages") or [])
    old_stage = "stage1_2_p0_task_synthesis"
    if old_stage in completed:
        binding = state["inputs"]["bindings"][0]
        contract = {
            "mode": "local",
            "profile_ids": [binding["profile_id"]],
            "scenario_ids": [binding["scenario_id"]],
            "binding_ids": [binding["binding_id"]],
            "scenario_contributions": [],
            "integration_reason": "migrated single-context v1 run",
        }
        tasks = state.get("p0_tasks") or []
        for task in tasks:
            task.setdefault("context_contract", dict(contract))
            task.setdefault("candidate_origin", "legacy_local")
        state.setdefault("context_plan", {
            "local_bindings": state["inputs"]["bindings"],
            "bridge_candidates": [],
            "bridge_groups": [],
            "policy": {"migration": "v1_single_context"},
        })
        state.setdefault("p0_local_candidates", tasks)
        state.setdefault("p0_task_candidates", tasks)
        state.setdefault("p0_complexity_passed", tasks)
        replacement = list(STAGE_ORDER[:6])
        completed = replacement + [item for item in completed if item not in {"stage1_1_input_validation", old_stage}]
        state["completed_stages"] = [item for item in STAGE_ORDER if item in completed]
        state["migration"] = {
            "source_schema": state.get("schema_version") or "object-relation-pipeline.v1",
            "mode": "preserve_completed_v1_p0",
        }
    state["schema_version"] = "object-relation-pipeline.v2"
    state["stage_order"] = list(STAGE_ORDER)
    completed = list(state.get("completed_stages") or [])
    state["next_stage"] = STAGE_ORDER[len(completed)] if len(completed) < len(STAGE_ORDER) else None


def save_state(run_dir: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    atomic_write_json(run_dir / "run.json", state)


def persist_stage(
    run_dir: Path,
    stage_name: str,
    execution: StageExecution,
    *,
    duration_ms: int,
) -> dict[str, Any]:
    stage_dir = run_dir / "stages" / stage_name
    write_value(stage_dir / "input.json", execution.input_payload)
    write_value(stage_dir / "output.json", execution.output)
    write_value(stage_dir / "trace.json", execution.trace)
    for relative_name, value in execution.files.items():
        write_value(stage_dir / relative_name, value)
    metadata = {
        "stage": stage_name,
        "status": "completed",
        "duration_ms": duration_ms,
        "directory": f"stages/{stage_name}",
        "files": sorted(
            str(path.relative_to(stage_dir)).replace("\\", "/")
            for path in stage_dir.rglob("*")
            if path.is_file()
        ),
    }
    write_value(stage_dir / "stage.json", metadata)
    return metadata


def persist_failure(run_dir: Path, stage_name: str, error: Exception) -> None:
    stage_dir = run_dir / "stages" / stage_name
    write_value(
        stage_dir / "stage.json",
        {
            "stage": stage_name,
            "status": "failed",
            "error_type": error.__class__.__name__,
            "message": str(error),
        },
    )


def list_runs(runs_root: Path, limit: int = 50) -> list[dict[str, Any]]:
    if not runs_root.is_dir():
        return []
    results: list[dict[str, Any]] = []
    for directory in sorted((item for item in runs_root.iterdir() if item.is_dir()), reverse=True):
        try:
            state = load_state(runs_root, directory.name)
        except (OSError, ValueError, FileNotFoundError, json.JSONDecodeError):
            continue
        results.append({
            "run_id": state.get("run_id"),
            "run_status": state.get("run_status"),
            "model_name": state.get("model_name"),
            "next_stage": state.get("next_stage"),
            "summary": state.get("summary") or {},
            "updated_at": state.get("updated_at"),
        })
        if len(results) >= limit:
            break
    return results

