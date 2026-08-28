from __future__ import annotations

import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from .contracts import STAGE_ORDER, StageExecution


RUN_ID_PATTERN = re.compile(r"^orun-[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


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
    profile: str,
    scenario: str,
    model_mode: str,
    model_name: str,
    options: dict[str, Any],
) -> dict[str, Any]:
    validate_run_id(run_id)
    return {
        "schema_version": "object-relation-pipeline.v1",
        "run_id": run_id,
        "run_status": "in_progress",
        "model_mode": model_mode,
        "model_name": model_name,
        "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "inputs": {"profile": profile, "scenario": scenario},
        "options": options,
        "stage_order": list(STAGE_ORDER),
        "completed_stages": [],
        "next_stage": STAGE_ORDER[0],
        "stage_results": {},
        "summary": {
            "p0_tasks": 0,
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
    return state


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

