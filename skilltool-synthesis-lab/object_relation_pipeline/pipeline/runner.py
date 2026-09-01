from __future__ import annotations

import time
from pathlib import Path
from typing import Any, Callable

from .contracts import STAGE_ORDER, StageContext, StageExecution
from .storage import persist_failure, persist_stage, save_state, write_value
from . import (
    stage1_1_input_validation,
    stage1_2_context_binding_planning,
    stage1_3_p0_local_synthesis,
    stage1_4_p0_cross_context_synthesis,
    stage1_5_p0_complexity_validation,
    stage1_6_p0_portfolio_finalization,
    stage2_1_relation_extraction,
    stage2_2_object_clustering,
    stage3_1_relation_sampling,
    stage3_2_p1_task_generation,
    stage3_3_p1_task_validation,
    stage4_1_skill_generation,
    stage4_2_artifact_finalization,
)


STAGE_RUNNERS: dict[str, Callable[[StageContext], StageExecution]] = {
    "stage1_1_input_validation": stage1_1_input_validation.run,
    "stage1_2_context_binding_planning": stage1_2_context_binding_planning.run,
    "stage1_3_p0_local_synthesis": stage1_3_p0_local_synthesis.run,
    "stage1_4_p0_cross_context_synthesis": stage1_4_p0_cross_context_synthesis.run,
    "stage1_5_p0_complexity_validation": stage1_5_p0_complexity_validation.run,
    "stage1_6_p0_portfolio_finalization": stage1_6_p0_portfolio_finalization.run,
    "stage2_1_relation_extraction": stage2_1_relation_extraction.run,
    "stage2_2_object_clustering": stage2_2_object_clustering.run,
    "stage3_1_relation_sampling": stage3_1_relation_sampling.run,
    "stage3_2_p1_task_generation": stage3_2_p1_task_generation.run,
    "stage3_3_p1_task_validation": stage3_3_p1_task_validation.run,
    "stage4_1_skill_generation": stage4_1_skill_generation.run,
    "stage4_2_artifact_finalization": stage4_2_artifact_finalization.run,
}


def resolve_stage(value: str) -> str:
    if value in STAGE_ORDER:
        return value
    matches = [item for item in STAGE_ORDER if item.startswith(value + "_") or item == value]
    if len(matches) != 1:
        raise ValueError(f"unknown or ambiguous stage: {value}")
    return matches[0]


class PipelineRunner:
    def __init__(
        self,
        *,
        runs_root: Path,
        base_model: Any,
        relation_model: Any,
    ) -> None:
        self.runs_root = runs_root
        self.base_model = base_model
        self.relation_model = relation_model

    def run_interval(
        self,
        state: dict[str, Any],
        *,
        from_stage: str,
        to_stage: str,
        progress_callback: Callable[[str, str], None] | None = None,
    ) -> dict[str, Any]:
        start = resolve_stage(from_stage)
        end = resolve_stage(to_stage)
        start_index = STAGE_ORDER.index(start)
        end_index = STAGE_ORDER.index(end)
        if start_index > end_index:
            raise ValueError("from_stage must not be after to_stage")
        completed = list(state.get("completed_stages") or [])
        missing_prerequisites = [item for item in STAGE_ORDER[:start_index] if item not in completed]
        if missing_prerequisites:
            raise ValueError(f"missing prerequisite stages: {missing_prerequisites}")
        run_dir = self.runs_root / state["run_id"]
        run_dir.mkdir(parents=True, exist_ok=True)
        save_state(run_dir, state)

        for stage_name in STAGE_ORDER[start_index : end_index + 1]:
            if stage_name in completed:
                if progress_callback:
                    progress_callback(stage_name, "skipped")
                continue
            expected_index = len(completed)
            if expected_index >= len(STAGE_ORDER) or STAGE_ORDER[expected_index] != stage_name:
                raise ValueError(f"next required stage is {STAGE_ORDER[expected_index] if expected_index < len(STAGE_ORDER) else 'none'}")
            if progress_callback:
                progress_callback(stage_name, "started")
            started = time.perf_counter()
            try:
                execution = STAGE_RUNNERS[stage_name](StageContext(
                    state=state,
                    run_dir=run_dir,
                    base_model=self.base_model,
                    relation_model=self.relation_model,
                    options=state.get("options") or {},
                ))
                duration_ms = round((time.perf_counter() - started) * 1000)
                metadata = persist_stage(run_dir, stage_name, execution, duration_ms=duration_ms)
                state.update(execution.state_updates)
                completed.append(stage_name)
                state["completed_stages"] = completed
                state.setdefault("stage_results", {})[stage_name] = metadata
                state.setdefault("timing", {})[stage_name] = duration_ms
                state["next_stage"] = STAGE_ORDER[len(completed)] if len(completed) < len(STAGE_ORDER) else None
                state["run_status"] = "completed" if state["next_stage"] is None else "in_progress"
                state.pop("error", None)
                save_state(run_dir, state)
                self._write_manifest(run_dir, state)
                if progress_callback:
                    progress_callback(stage_name, "completed")
            except Exception as error:
                state["run_status"] = "failed"
                state["next_stage"] = stage_name
                state["error"] = {
                    "stage": stage_name,
                    "type": error.__class__.__name__,
                    "message": str(error),
                }
                persist_failure(run_dir, stage_name, error)
                save_state(run_dir, state)
                self._write_manifest(run_dir, state)
                if progress_callback:
                    progress_callback(stage_name, "failed")
                raise
        return state

    @staticmethod
    def _write_manifest(run_dir: Path, state: dict[str, Any]) -> None:
        write_value(
            run_dir / "stage-manifest.json",
            {
                "run_id": state.get("run_id"),
                "run_status": state.get("run_status"),
                "next_stage": state.get("next_stage"),
                "stage_order": list(STAGE_ORDER),
                "completed_stages": state.get("completed_stages") or [],
                "stages": state.get("stage_results") or {},
            },
        )

