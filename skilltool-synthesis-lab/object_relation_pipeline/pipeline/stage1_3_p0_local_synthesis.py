from __future__ import annotations

import re
import sys
from copy import deepcopy
from pathlib import Path

from .contexts import context_indexes, contract_for_binding
from .contracts import StageContext, StageExecution
from .storage import write_value


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.synthesis import SynthesisPipeline  # noqa: E402


STAGE_NAME = "stage1_3_p0_local_synthesis"


def _task_id(binding_id: str, raw: object, index: int) -> str:
    suffix = re.sub(r"[^a-zA-Z0-9_-]+", "_", str(raw or f"task_{index:03d}")).strip("_")
    return f"p0_{binding_id}_{suffix}"


def run(context: StageContext) -> StageExecution:
    plan = context.state.get("context_plan") or {}
    bindings = plan.get("local_bindings") or []
    if not bindings:
        raise ValueError("context plan must contain local bindings")
    profile_by_id, scenario_by_id = context_indexes(context.state["inputs"])
    candidates = []
    base_results = []
    traces = []
    files = {}
    for binding in bindings:
        binding_id = str(binding["binding_id"])
        item_dir = context.run_dir / "stages" / STAGE_NAME / "bindings" / binding_id
        profile = profile_by_id[str(binding["profile_id"])]
        scenario = scenario_by_id[str(binding["scenario_id"])]
        write_value(item_dir / "input.json", {"binding": binding, "profile": profile, "scenario": scenario})
        pipeline = SynthesisPipeline(
            context.base_model,
            runs_root=None,
            task_iteration_limit=1,
            task_iteration_directions=("initialization",),
        )
        result = pipeline.create_result(
            profile=profile["content"],
            scenario=scenario["content"],
            model_mode=context.state["model_mode"],
        )
        pipeline.advance(result, "input_validation")
        write_value(item_dir / "input-validation.json", result.get("input_validation") or {})
        try:
            pipeline.advance(result, "task_synthesis")
        except Exception as error:
            write_value(item_dir / "failure.json", {"type": error.__class__.__name__, "message": str(error)})
            write_value(item_dir / "failure-model-trace.json", deepcopy(getattr(context.base_model, "last_trace", {}) or {}))
            raise
        tasks = deepcopy((result.get("task_map") or {}).get("tasks") or [])
        if not tasks:
            raise ValueError(f"reused P0 synthesis returned no tasks for {binding_id}")
        for index, task in enumerate(tasks, start=1):
            task["source_task_id"] = task.get("task_id")
            task["task_id"] = _task_id(binding_id, task.get("task_id"), index)
            task["context_contract"] = contract_for_binding(binding)
            task["candidate_origin"] = "local"
            candidates.append(task)
        model_trace = next(
            (item for item in reversed(result.get("synthesis_trace") or []) if item.get("stage") == "task_synthesis"),
            {},
        )
        compact_base = deepcopy(result)
        compact_base["task_map"]["tasks"] = tasks
        base_results.append({"binding_id": binding_id, "result": compact_base})
        traces.append({"binding_id": binding_id, "model_trace": model_trace, "task_count": len(tasks)})
        write_value(item_dir / "tasks.json", tasks)
        write_value(item_dir / "base-pipeline-result.json", compact_base)
        write_value(item_dir / "model-trace.json", model_trace)
        files[f"bindings/{binding_id}/tasks.json"] = tasks
        files[f"bindings/{binding_id}/input.json"] = {"binding": binding, "profile": profile, "scenario": scenario}
        files[f"bindings/{binding_id}/input-validation.json"] = result.get("input_validation") or {}
        files[f"bindings/{binding_id}/base-pipeline-result.json"] = compact_base
        files[f"bindings/{binding_id}/model-trace.json"] = model_trace
    return StageExecution(
        input_payload={"local_bindings": bindings},
        output={"local_candidates": candidates, "binding_summaries": traces},
        state_updates={"p0_local_candidates": candidates, "p0_base_results": base_results},
        trace={"operation": "reused_initial_task_pool_synthesis_per_binding", "bindings": traces},
        files={**files, "p0-local-candidates.json": candidates},
    )
