from __future__ import annotations

from datetime import datetime
import time
from typing import Any

from .artifacts import build_artifact_preview


def validate_direct_candidates(
    tasks: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    tool_catalog: dict[str, Any] | None = None,
) -> dict[str, Any]:
    expected = {str(task.get("task_id")) for task in tasks}
    covered = [
        str(task_id)
        for candidate in candidates
        for task_id in candidate.get("task_ids") or []
    ]
    errors: list[str] = []
    available_tool_names = (
        {
            str(tool.get("name"))
            for tool in tool_catalog.get("tools") or []
            if tool.get("selectable_for_skilltool") is True
            and tool.get("implementation_status") != "missing"
        }
        if tool_catalog is not None
        else None
    )
    tool_by_name = {
        str(tool.get("name")): tool
        for tool in (tool_catalog or {}).get("tools") or []
        if isinstance(tool, dict) and tool.get("name")
    }
    if set(covered) != expected or len(covered) != len(expected):
        errors.append("eligible tasks are not covered exactly once")
    for candidate in candidates:
        skill_id = str(candidate.get("skill_id") or "unknown")
        if not candidate.get("skill_name") or not candidate.get("tool_name"):
            errors.append(f"{skill_id}: skill_name and tool_name are required")
        if not (candidate.get("operating_model") or {}).get("workflow"):
            errors.append(f"{skill_id}: executable workflow is missing")
        child_tools = set(map(str, candidate.get("child_tools") or []))
        selected_tools = {
            str(item.get("tool_name"))
            for item in candidate.get("tool_selection") or []
            if isinstance(item, dict) and item.get("tool_name")
        }
        if child_tools != selected_tools:
            errors.append(f"{skill_id}: child_tools do not match tool_selection")
        if available_tool_names is not None:
            unknown_tools = sorted(child_tools - available_tool_names)
            if unknown_tools:
                errors.append(
                    f"{skill_id}: tools are not in the Career Agent allowlist: {unknown_tools}"
                )
        for tool_name in child_tools:
            for prerequisite in tool_by_name.get(tool_name, {}).get("prerequisites") or []:
                if (
                    isinstance(prerequisite, dict)
                    and prerequisite.get("type") == "required"
                    and prerequisite.get("name") not in child_tools
                ):
                    errors.append(
                        f"{skill_id}: tool {tool_name} requires {prerequisite.get('name')}"
                    )
        harness_names: set[str] = set()
        for tool in candidate.get("harness_tools") or []:
            if not isinstance(tool, dict) or not tool.get("tool_name"):
                errors.append(f"{skill_id}: invalid harness tool declaration")
                continue
            name = str(tool["tool_name"])
            if name in harness_names or name in child_tools:
                errors.append(f"{skill_id}: duplicate or conflicting harness tool {name}")
            harness_names.add(name)
            steps = tool.get("steps") or []
            if tool.get("phase") not in {"before_skill", "after_skill"}:
                errors.append(f"{skill_id}: harness tool {name} has invalid phase")
            if not tool.get("purpose") or not tool.get("trigger") or not 2 <= len(steps) <= 5:
                errors.append(f"{skill_id}: harness tool {name} needs purpose, trigger, and 2-5 steps")
            if not isinstance(tool.get("input"), dict) or not isinstance(tool.get("output"), dict):
                errors.append(f"{skill_id}: harness tool {name} needs typed input and output contracts")
    return {
        "passed": not errors,
        "errors": errors,
        "expected_task_count": len(expected),
        "covered_task_count": len(set(covered)),
        "candidate_count": len(candidates),
        "harness_tool_count": sum(len(item.get("harness_tools") or []) for item in candidates),
    }


def finalize_direct_result(result: dict[str, Any], *, generator: str) -> dict[str, Any]:
    tasks = [
        task
        for task in (result.get("task_map") or {}).get("tasks") or []
        if task.get("synthesis_decision") == "skilltool"
    ]
    candidates = list(
        (result.get("candidate_generation") or {}).get("raw_candidates") or []
    )
    validation_started = time.perf_counter()
    validation = validate_direct_candidates(
        tasks, candidates, result.get("tool_catalog")
    )
    validation_duration_ms = round((time.perf_counter() - validation_started) * 1000)
    if not validation["passed"]:
        raise ValueError("direct synthesis validation failed: " + "; ".join(validation["errors"]))
    result["final_candidates"] = candidates
    render_started = time.perf_counter()
    result["artifacts"] = [build_artifact_preview(item) for item in candidates]
    render_duration_ms = round((time.perf_counter() - render_started) * 1000)
    composition_duration_ms = next(
        (
            int(stage.get("duration_ms") or 0)
            for stage in reversed(result.get("stages") or [])
            if stage.get("stage") == "candidate_synthesis"
        ),
        0,
    )
    timing = result.setdefault("timing", {})
    prior_elapsed_ms = int(timing.get("prior_elapsed_ms") or 0)
    completed_non_candidate_ms = sum(
        int(stage.get("duration_ms") or 0)
        for stage in result.get("stages") or []
        if stage.get("stage") != "candidate_synthesis"
    )
    composition_total_duration_ms = composition_duration_ms + max(
        0, prior_elapsed_ms - completed_non_candidate_ms
    )
    result["run_status"] = "completed"
    result["next_stage"] = None
    result["direct_synthesis"] = {
        "enabled": True,
        "source": "final_task_pool",
        "generator": generator,
        "reference_root": "ref/skills",
        "stages": [
            {
                "id": "task_tool_composition",
                "label": "任务与工具组合",
                "status": "completed",
                "duration_ms": composition_total_duration_ms,
                "detail": "为每个任务选择最小必要普通工具，并判断是否需要简单 Harness Tool。",
            },
            {
                "id": "reference_render",
                "label": "参考样式生成",
                "status": "completed",
                "duration_ms": render_duration_ms,
                "detail": "按照 ref/skills 与 ref/tools 的边界、工作流和契约模式生成。",
            },
            {
                "id": "artifact_validation",
                "label": "产物校验",
                "status": "completed",
                "duration_ms": validation_duration_ms,
                "detail": "检查任务覆盖、工具声明、Harness 工序和产物结构。",
            },
        ],
        "skipped_stages": ["dedupe_merge", "quality_gate"],
        "task_count": len(tasks),
        "artifact_count": len(candidates),
        "validation": validation,
    }
    summary = result.setdefault("summary", {})
    summary["skilltools"] = len(candidates)
    summary["eligible_artifacts"] = len(candidates)
    summary["quality_status"] = "direct_validation_passed"
    summary["failed_rubrics"] = 0
    summary["warning_rubrics"] = 0
    stage_durations = timing.setdefault("stage_duration_ms", {})
    stage_durations.update(
        {
            "task_tool_composition": composition_total_duration_ms,
            "reference_render": render_duration_ms,
            "artifact_validation": validation_duration_ms,
        }
    )
    timing["completed_at"] = datetime.now().astimezone().isoformat(timespec="seconds")
    if prior_elapsed_ms:
        timing["total_duration_ms"] = (
            completed_non_candidate_ms
            + composition_total_duration_ms
            + render_duration_ms
            + validation_duration_ms
        )
    else:
        timing["total_duration_ms"] = sum(
            int(value or 0)
            for key, value in stage_durations.items()
            if key != "candidate_synthesis"
        )
    return result
