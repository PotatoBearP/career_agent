from __future__ import annotations

import time
import uuid
import json
from pathlib import Path
from typing import Any, Protocol

from .artifact_store import persist_step_json
from .step1_synthesis_prompts import (
    SYSTEM_PROMPT,
    candidate_synthesis_prompt,
    dedupe_merge_prompt,
    demand_analysis_prompt,
    task_synthesis_prompt,
)
from .step2_quality_gate import consolidate_candidates, evaluate_portfolio
from .step3_artifact_generation import build_artifact_preview, persist_run


class JsonModel(Protocol):
    def complete_json(self, *, system: str, user: str) -> Any: ...


class PipelineError(RuntimeError):
    def __init__(self, stage: str, message: str) -> None:
        super().__init__(f"{stage}: {message}")
        self.stage = stage


def _object(stage: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PipelineError(stage, "model output must be a JSON object")
    return value


def _array(stage: str, value: Any, key: str) -> list[dict[str, Any]]:
    items = value.get(key)
    if not isinstance(items, list) or not items:
        raise PipelineError(stage, f"model output must contain non-empty {key}")
    if not all(isinstance(item, dict) for item in items):
        raise PipelineError(stage, f"every {key} entry must be an object")
    return items


class SynthesisPipeline:
    def __init__(
        self,
        model: JsonModel,
        *,
        runs_root: Path | None = None,
        tool_catalog: dict[str, Any] | None = None,
        skilltool_template: dict[str, Any] | None = None,
    ) -> None:
        self.model = model
        self.runs_root = runs_root
        data_root = Path(__file__).resolve().parents[1] / "data"
        self.tool_catalog = tool_catalog or json.loads(
            (data_root / "tools/project_tools.json").read_text(encoding="utf-8")
        )
        self.skilltool_template = skilltool_template or json.loads(
            (data_root / "templates/skilltool_template.json").read_text(encoding="utf-8")
        )

    def _stage(self, name: str, prompt: str) -> tuple[dict[str, Any], dict[str, Any]]:
        started = time.perf_counter()
        try:
            output = _object(
                name,
                self.model.complete_json(system=SYSTEM_PROMPT, user=prompt),
            )
        except PipelineError:
            raise
        except Exception as error:
            raise PipelineError(name, str(error)) from error
        return output, {
            "stage": name,
            "status": "completed",
            "duration_ms": round((time.perf_counter() - started) * 1000),
        }

    def run(
        self,
        *,
        profile: dict[str, Any],
        state: dict[str, Any],
        scenario: dict[str, Any],
        persist: bool = True,
        model_mode: str = "api",
    ) -> dict[str, Any]:
        if not profile or not state or not scenario:
            raise PipelineError("input", "profile, state, and scenario are required")

        run_id = f"run-{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
        stage_meta: list[dict[str, Any]] = []
        demand_prompt = demand_analysis_prompt(profile, state, scenario)
        demand_analysis, meta = self._stage(
            "demand_analysis",
            demand_prompt,
        )
        _array("demand_analysis", demand_analysis, "needs")
        stage_meta.append(meta)
        if persist:
            if self.runs_root is None:
                raise PipelineError("persist", "runs_root is not configured")
            persist_step_json(
                self.runs_root,
                run_id,
                "step1_demand_analysis",
                {
                    "request.json": {
                        "model_mode": model_mode,
                        "inputs": {
                            "profile": profile,
                            "state": state,
                            "scenario": scenario,
                        },
                        "system_prompt": SYSTEM_PROMPT,
                        "user_prompt": demand_prompt,
                    },
                    "demand_analysis.json": demand_analysis,
                },
            )

        task_map, meta = self._stage(
            "task_synthesis",
            task_synthesis_prompt(profile, state, scenario, demand_analysis),
        )
        _array("task_synthesis", task_map, "tasks")
        stage_meta.append(meta)

        candidate_output, meta = self._stage(
            "candidate_synthesis",
            candidate_synthesis_prompt(
                profile,
                state,
                scenario,
                demand_analysis,
                task_map,
                self.tool_catalog,
                self.skilltool_template,
            ),
        )
        raw_candidates = _array("candidate_synthesis", candidate_output, "candidates")
        stage_meta.append(meta)

        dedupe_output, meta = self._stage(
            "dedupe_merge",
            dedupe_merge_prompt(candidate_output, task_map),
        )
        reviewed_candidates = _array("dedupe_merge", dedupe_output, "final_candidates")
        stage_meta.append(meta)

        consolidated, deterministic_merges = consolidate_candidates(reviewed_candidates)
        quality_started = time.perf_counter()
        quality = evaluate_portfolio(
            consolidated,
            task_map,
            tool_catalog=self.tool_catalog,
            scenario=scenario,
        )
        stage_meta.append(
            {
                "stage": "quality_gate",
                "status": "completed" if quality["passed"] else "needs_revision",
                "duration_ms": round((time.perf_counter() - quality_started) * 1000),
            }
        )

        report_by_skill = {
            report["skill_id"]: report for report in quality["candidate_reports"]
        }
        eligible = [
            candidate
            for candidate in consolidated
            if report_by_skill.get(candidate.get("skill_id"), {}).get("passed")
        ]
        artifacts = [build_artifact_preview(candidate) for candidate in eligible]
        result: dict[str, Any] = {
            "run_id": run_id,
            "model_mode": model_mode,
            "inputs": {"profile": profile, "state": state, "scenario": scenario},
            "skilltool_template": self.skilltool_template,
            "tool_catalog": self.tool_catalog,
            "stages": stage_meta,
            "demand_analysis": demand_analysis,
            "task_map": task_map,
            "candidate_generation": {
                "raw_count": len(raw_candidates),
                "reviewed_count": len(reviewed_candidates),
                "final_count": len(consolidated),
                "raw_candidates": raw_candidates,
                "dedupe_decisions": dedupe_output.get("decisions") or [],
                "deterministic_merges": deterministic_merges,
                "portfolio_notes": dedupe_output.get("portfolio_notes") or [],
            },
            "final_candidates": consolidated,
            "quality": quality,
            "artifacts": artifacts,
            "summary": {
                "needs": len(demand_analysis.get("needs") or []),
                "tasks": len(task_map.get("tasks") or []),
                "skilltools": len(consolidated),
                "eligible_artifacts": len(artifacts),
                "quality_score": quality["score"],
            },
        }
        if persist:
            if self.runs_root is None:
                raise PipelineError("persist", "runs_root is not configured")
            run_dir = persist_run(self.runs_root, run_id, result)
            result["run_directory"] = str(run_dir)
        return result
