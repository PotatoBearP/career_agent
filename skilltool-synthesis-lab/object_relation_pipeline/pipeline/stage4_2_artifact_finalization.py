from __future__ import annotations

import sys
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

from .contracts import StageContext, StageExecution
from .storage import write_value


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.direct_synthesis import finalize_direct_result  # noqa: E402


STAGE_NAME = "stage4_2_artifact_finalization"
INTERNAL_METADATA_PATTERNS = {
    "task_id_field": re.compile(r"\b(?:p[01]_)?task_id\b", re.IGNORECASE),
    "p0_p1_task_identifier": re.compile(r"\bp[01]_task_[a-z0-9_-]+\b", re.IGNORECASE),
    "relation_metadata": re.compile(r"\brelation_(?:contract|id|signature|label)\b", re.IGNORECASE),
    "object_id_field": re.compile(r"\b(?:input_|output_)?object_id\b", re.IGNORECASE),
    "canonical_object_identifier": re.compile(r"\bobj_[a-z0-9_]+_[0-9a-f]{8}\b", re.IGNORECASE),
    "mention_metadata": re.compile(r"\bmention_(?:id|\d+_[io]_\d+)\b", re.IGNORECASE),
    "sample_relation_identifier": re.compile(r"\bsample_relation_[a-z0-9_-]+\b", re.IGNORECASE),
    "sampling_metadata": re.compile(r"\bsampling_(?:seed|mode|evidence)\b", re.IGNORECASE),
    "pipeline_stage_identifier": re.compile(r"\bstage[1-4]_\d+(?:_[a-z0-9_]+)?\b", re.IGNORECASE),
    "chinese_internal_metadata": re.compile(r"(?:P[01]任务ID|任务ID|关系契约|关系ID|对象ID|Mention ID|中间产物ID)", re.IGNORECASE),
}
VALIDATION_EXCLUDED_FIELDS = {
    "task_ids", "relation_contract",  # explicit design-time trace fields
    "skill_id", "skill_name", "tool_name",  # candidate/callable identity, not runtime information
}


def _metadata_violations(value: Any, *, path: str, skill_id: str) -> list[dict[str, str]]:
    violations: list[dict[str, str]] = []
    if isinstance(value, dict):
        for key, item in value.items():
            key_path = f"{path}.{key}" if path else str(key)
            violations.extend(_metadata_violations(str(key), path=f"{key_path}#key", skill_id=skill_id))
            violations.extend(_metadata_violations(item, path=key_path, skill_id=skill_id))
        return violations
    if isinstance(value, list):
        for index, item in enumerate(value):
            violations.extend(_metadata_violations(item, path=f"{path}[{index}]", skill_id=skill_id))
        return violations
    if not isinstance(value, str):
        return violations
    compact = " ".join(value.split())
    for code, pattern in INTERNAL_METADATA_PATTERNS.items():
        match = pattern.search(value)
        if match:
            violations.append({
                "skill_id": skill_id,
                "path": path,
                "code": code,
                "matched": match.group(0),
                "excerpt": compact[:180],
            })
    return violations


def validate_runtime_metadata_boundaries(candidates: list[dict[str, Any]]) -> dict[str, Any]:
    violations: list[dict[str, str]] = []
    checked_skills = []
    for index, candidate in enumerate(candidates, start=1):
        skill_id = str(candidate.get("skill_id") or candidate.get("skill_name") or f"candidate_{index}")
        checked_skills.append(skill_id)
        runtime_view = {
            key: value
            for key, value in candidate.items()
            if key not in VALIDATION_EXCLUDED_FIELDS
        }
        violations.extend(_metadata_violations(runtime_view, path="candidate", skill_id=skill_id))
    return {
        "passed": not violations,
        "policy": "pipeline control metadata is allowed only in top-level trace fields, never in runtime or public Skill surfaces",
        "excluded_non_runtime_fields": sorted(VALIDATION_EXCLUDED_FIELDS),
        "checked_skills": checked_skills,
        "violation_count": len(violations),
        "violations": violations,
    }


def run(context: StageContext) -> StageExecution:
    working = deepcopy(context.state.get("skill_working_result") or {})
    if not working:
        raise ValueError("Skill candidate generation result is required")
    generator = "configured_model" if context.state.get("model_mode") == "api" else "mock_model"
    finalize_direct_result(working, generator=generator)
    runtime_metadata_validation = validate_runtime_metadata_boundaries(
        list(working.get("final_candidates") or [])
    )
    stage_dir = context.run_dir / "stages" / STAGE_NAME
    write_value(stage_dir / "runtime-metadata-validation.json", runtime_metadata_validation)
    working.setdefault("direct_synthesis", {})["runtime_metadata_validation"] = runtime_metadata_validation
    if not runtime_metadata_validation["passed"]:
        first = runtime_metadata_validation["violations"][0]
        raise ValueError(
            "runtime metadata boundary validation failed: "
            f"{first['skill_id']} {first['path']} contains {first['matched']}"
        )
    relation_by_task = {
        str(task.get("task_id")): deepcopy(task.get("relation_contract") or {})
        for task in context.state.get("p1_tasks") or []
    }
    for artifact in working.get("artifacts") or []:
        candidate = next(
            (
                item for item in working.get("final_candidates") or []
                if str(item.get("skill_name") or item.get("skill_id")) == str(artifact.get("skill_name"))
                or str(item.get("skill_name") or "").replace("_", "-") == str(artifact.get("skill_name"))
            ),
            None,
        )
        if candidate is not None:
            task_id = str((candidate.get("task_ids") or [""])[0])
            artifact["files"]["relation-contract.json"] = relation_by_task.get(task_id) or candidate.get("relation_contract") or {}
        skill_dir = context.run_dir / "generated-skills" / artifact["skill_name"]
        for relative_name, value in artifact["files"].items():
            write_value(skill_dir / relative_name, value)
    skill_count = len(working.get("artifacts") or [])
    return StageExecution(
        input_payload={
            "skill_candidates": context.state.get("skill_candidates") or [],
            "reuse": "../pipeline/direct_synthesis.py::finalize_direct_result",
        },
        output={
            "direct_synthesis": working.get("direct_synthesis") or {},
            "final_candidates": working.get("final_candidates") or [],
            "artifacts": working.get("artifacts") or [],
        },
        state_updates={
            "skill_result": working,
            "skill_candidates": working.get("final_candidates") or [],
            "artifacts": working.get("artifacts") or [],
            "summary": {**context.state.get("summary", {}), "skills": skill_count},
        },
        trace={
            "operation": "reused_existing_direct_validation_and_artifact_rendering",
            "source": "../pipeline/direct_synthesis.py::finalize_direct_result",
            "validation": (working.get("direct_synthesis") or {}).get("validation") or {},
            "runtime_metadata_validation": runtime_metadata_validation,
        },
        files={
            "direct-synthesis.json": working.get("direct_synthesis") or {},
            "runtime-metadata-validation.json": runtime_metadata_validation,
            "final-candidates.json": working.get("final_candidates") or [],
            "artifact-index.json": [
                {"skill_name": item.get("skill_name"), "files": sorted((item.get("files") or {}).keys())}
                for item in working.get("artifacts") or []
            ],
        },
    )

