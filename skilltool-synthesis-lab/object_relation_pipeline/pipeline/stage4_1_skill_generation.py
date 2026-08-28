from __future__ import annotations

import sys
from copy import deepcopy
from pathlib import Path

from .contracts import StageContext, StageExecution


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.synthesis import SynthesisPipeline, build_task_io_pools  # noqa: E402


STAGE_NAME = "stage4_1_skill_generation"
RUNTIME_INPUT_BOUNDARY = """
OBJECT-RELATION PIPELINE RUNTIME INPUT BOUNDARY:
- P0/P1 task IDs, relation_contract, relation IDs/signatures/labels, object IDs, mention IDs, sampling fields, provenance, stage names, traces, and other pipeline bookkeeping are private design-time metadata.
- Metadata may be used only to match this candidate to its requested task. Never place it in input_schema, output_schema, composition fields, workflow variables, user-facing instructions, example requests, or required context.
- Every input_schema field must represent real domain information obtainable from the user, a real existing artifact, an allowed ordinary tool, or a prior Skill output.
- Use semantic field names and descriptions. Never ask a user or tool to provide an internal identifier or contract object.
""".strip()


class _RuntimeInputConstrainedModel:
    """Add the new pipeline's input boundary while preserving the reused model interface."""

    def __init__(self, delegate: object) -> None:
        self.delegate = delegate

    @property
    def config(self):
        return getattr(self.delegate, "config", None)

    @property
    def last_trace(self):
        return getattr(self.delegate, "last_trace", {})

    @property
    def max_tokens_override(self):
        return getattr(self.delegate, "max_tokens_override", None)

    @max_tokens_override.setter
    def max_tokens_override(self, value) -> None:
        if hasattr(self.delegate, "max_tokens_override"):
            self.delegate.max_tokens_override = value

    def complete_json(self, *, system: str, user: str):
        return self.delegate.complete_json(
            system=system,
            user=f"{user}\n\n{RUNTIME_INPUT_BOUNDARY}",
        )


def _skill_generation_task(task: dict) -> dict:
    """Expose semantic task contracts to Skill synthesis, not relation-pipeline metadata."""
    sanitized = {
        key: deepcopy(task.get(key))
        for key in (
            "task_id", "name", "business_goal", "user_request_examples", "invocation_mode",
            "synthesis_decision", "decision_reason", "fresh_data_required",
        )
    }
    sanitized.update({
        "scene": "object_relation_sampled_task",
        "iteration": 2,
        "evolution_direction": "relation_sampling",
        "source_task_ids": [],
        "parallel_group": "sampled_object_relations",
        "execution_provider": None,
        "need_ids": [],
        "dependencies": [],
        "estimated_steps": task.get("estimated_steps") or 3,
    })
    sanitized["inputs"] = []
    for field in task.get("inputs") or []:
        if not isinstance(field, dict):
            continue
        source = str(field.get("source") or "user_input")
        if source == "user_input":
            semantic_ref = None
        elif source in {"prior_output", "upstream_artifact"}:
            semantic_ref = field.get("name")
        else:
            semantic_ref = (field.get("acquisition") or {}).get("provider")
        acquisition = deepcopy(field.get("acquisition") or {})
        if source in {"user_input", "prior_output"}:
            acquisition["provider"] = None
        sanitized["inputs"].append({
            "name": field.get("name"),
            "display_name": field.get("display_name"),
            "description": field.get("description"),
            "type": field.get("type") or "object",
            "required": field.get("required") is not False,
            "input_origin": field.get("input_origin"),
            "source": source,
            "source_ref": semantic_ref,
            "available": field.get("available"),
            "from_task": None,
            "acquisition": acquisition,
        })
    sanitized["outputs"] = [
        {
            "name": field.get("name"),
            "display_name": field.get("display_name"),
            "description": field.get("description"),
            "type": field.get("type") or "object",
            "output_origin": "task_generated",
            "dedupe_key": field.get("name"),
            "inferred": True,
            "consumer_tasks": [],
            "final_consumer": field.get("final_consumer") or "user",
        }
        for field in task.get("outputs") or []
        if isinstance(field, dict) and field.get("name")
    ]
    return sanitized


def _replace_task_references_with_skill_names(candidates: list[dict]) -> list[dict]:
    task_to_skill = {
        str(task_id): str(candidate.get("skill_name") or candidate.get("skill_id") or task_id)
        for candidate in candidates
        for task_id in candidate.get("task_ids") or []
    }
    for candidate in candidates:
        for field in (candidate.get("input_schema") or {}).values():
            if not isinstance(field, dict):
                continue
            acquisition = field.get("acquisition") or {}
            provider = str(acquisition.get("provider") or "")
            if provider in task_to_skill:
                acquisition["provider"] = task_to_skill[provider]
        candidate["output_consumers"] = [
            task_to_skill.get(str(consumer), consumer)
            for consumer in candidate.get("output_consumers") or []
        ]
    return candidates


def _p1_task_map(state: dict) -> dict:
    tasks = [_skill_generation_task(task) for task in state.get("p1_tasks") or []]
    input_pool, output_pool = build_task_io_pools(tasks)
    return {
        "input_inventory": deepcopy((state.get("input_validation") or {}).get("input_inventory") or []),
        "input_pool": input_pool,
        "output_pool": output_pool,
        "iterations": [{
            "iteration": 1,
            "direction": "sampled_k_to_one_relations",
            "retained_task_ids": [item.get("task_id") for item in tasks],
            "inferred_outputs": output_pool,
        }],
        "iteration_checkpoints": [],
        "tasks": tasks,
        "coverage": [
            {
                "required_output": str((task.get("outputs") or [{}])[0].get("object_id") or (task.get("outputs") or [{}])[0].get("name") or task.get("task_id")),
                "covered_by": [task.get("task_id")],
            }
            for task in tasks
        ],
        "inferred_outputs": output_pool,
        "task_dedupe_decisions": [],
    }


def run(context: StageContext) -> StageExecution:
    p1_tasks = deepcopy(context.state.get("p1_tasks") or [])
    if not p1_tasks:
        raise ValueError("validated P1 task pool is required before Skill generation")
    base_result = deepcopy(context.state.get("p0_base_result") or {})
    if not base_result:
        raise ValueError("reused P0 base result is missing")
    base_result["run_id"] = context.state["run_id"]
    base_result["run_status"] = "in_progress"
    base_result["next_stage"] = "candidate_synthesis"
    base_result["task_map"] = _p1_task_map(context.state)
    base_result["candidate_generation"] = {
        "raw_count": 0,
        "reviewed_count": 0,
        "final_count": 0,
        "raw_candidates": [],
        "dedupe_decisions": [],
        "deterministic_merges": [],
        "portfolio_notes": [],
    }
    base_result["final_candidates"] = []
    base_result["artifacts"] = []
    base_result["stages"] = [
        item for item in base_result.get("stages") or []
        if item.get("stage") in {"input_validation", "task_synthesis"}
    ][:2]
    base_result["synthesis_trace"] = [
        item for item in base_result.get("synthesis_trace") or []
        if item.get("stage") in {"input_validation", "task_synthesis"}
    ][:2]
    pipeline = SynthesisPipeline(
        _RuntimeInputConstrainedModel(context.base_model),
        runs_root=None,
        tool_catalog=base_result.get("tool_catalog") or None,
        skilltool_template=base_result.get("skilltool_template") or None,
    )
    pipeline.advance(base_result, "candidate_synthesis")
    relation_by_task = {
        str(task.get("task_id")): deepcopy(task.get("relation_contract") or {})
        for task in p1_tasks
    }
    candidates = list((base_result.get("candidate_generation") or {}).get("raw_candidates") or [])
    _replace_task_references_with_skill_names(candidates)
    for candidate in candidates:
        task_id = str((candidate.get("task_ids") or [""])[0])
        candidate["relation_contract"] = relation_by_task.get(task_id) or {}
    base_result["candidate_generation"]["raw_candidates"] = candidates
    return StageExecution(
        input_payload={
            "p1_tasks": p1_tasks,
            "task_map": base_result["task_map"],
            "reuse": "../pipeline/synthesis.py::SynthesisPipeline.advance(candidate_synthesis)",
        },
        output={"skill_candidates": candidates},
        state_updates={
            "skill_candidates": candidates,
            "skill_working_result": base_result,
        },
        trace={
            "operation": "reused_existing_per_task_skill_candidate_synthesis",
            "source": "../pipeline/synthesis.py::SynthesisPipeline.advance(candidate_synthesis)",
            "candidate_stage_trace": (base_result.get("synthesis_trace") or [])[-1],
        },
        files={
            "p1-task-map.json": base_result["task_map"],
            "skill-candidates.json": candidates,
            "base-candidate-result.json": base_result,
        },
    )

