from __future__ import annotations

import sys
from copy import deepcopy
from pathlib import Path

from .contracts import StageContext, StageExecution


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.synthesis import SynthesisPipeline  # noqa: E402


STAGE_NAME = "stage1_2_p0_task_synthesis"


def run(context: StageContext) -> StageExecution:
    if not (context.state.get("input_validation") or {}).get("passed"):
        raise ValueError("stage1_1_input_validation must pass before P0 synthesis")
    inputs = context.state["inputs"]
    pipeline = SynthesisPipeline(
        context.base_model,
        runs_root=None,
        task_iteration_limit=1,
        task_iteration_directions=("initialization",),
    )
    result = pipeline.create_result(
        profile=inputs["profile"],
        scenario=inputs["scenario"],
        model_mode=context.state["model_mode"],
    )
    pipeline.advance(result, "input_validation")
    pipeline.advance(result, "task_synthesis")
    tasks = deepcopy((result.get("task_map") or {}).get("tasks") or [])
    if not tasks:
        raise ValueError("reused P0 synthesis returned no tasks")
    trace = next(
        (item for item in reversed(result.get("synthesis_trace") or []) if item.get("stage") == "task_synthesis"),
        {},
    )
    return StageExecution(
        input_payload={
            "profile": inputs["profile"],
            "scenario": inputs["scenario"],
            "input_validation": context.state["input_validation"],
        },
        output={"p0_tasks": tasks, "coverage": result["task_map"].get("coverage") or []},
        state_updates={
            "p0_tasks": tasks,
            "p0_base_result": result,
            "summary": {**context.state.get("summary", {}), "p0_tasks": len(tasks)},
        },
        trace={
            "operation": "reused_initial_task_pool_synthesis",
            "source": "../pipeline/synthesis.py::SynthesisPipeline.advance(task_synthesis)",
            "model_trace": trace,
        },
        files={
            "p0-tasks.json": tasks,
            "p0-task-map.json": result.get("task_map") or {},
            "base-pipeline-result.json": result,
        },
    )

