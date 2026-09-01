from __future__ import annotations

import re
import math
from copy import deepcopy
from typing import Any

from .contexts import context_pack
from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, cross_context_p0_prompt
from .storage import write_value


STAGE_NAME = "stage1_4_p0_cross_context_synthesis"
VALID_TYPES = {"object", "array", "string", "number", "boolean"}


def _snake(value: Any, fallback: str) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", str(value or "").lower()).strip("_") or fallback


def _field(raw: Any, index: int, role: str) -> dict[str, Any]:
    item = raw if isinstance(raw, dict) else {}
    name = _snake(item.get("name"), f"{role}_{index}")
    result = {
        "name": name,
        "display_name": str(item.get("display_name") or name),
        "description": str(item.get("description") or name),
        "type": str(item.get("type")) if str(item.get("type")) in VALID_TYPES else "object",
    }
    if role == "input":
        result["source"] = str(item.get("source")) if str(item.get("source")) in {
            "user_input", "upstream_artifact", "ordinary_tool_output", "prior_output"
        } else "user_input"
        result["scenario_ids"] = [str(value) for value in item.get("scenario_ids") or []]
    else:
        result["dedupe_key"] = name
    return result


def run(context: StageContext) -> StageExecution:
    local = deepcopy(context.state.get("p0_local_candidates") or [])
    groups = (context.state.get("context_plan") or {}).get("bridge_groups") or []
    policy = context.options.get("p0") or {}
    desired_bridge_count = math.ceil(int(policy.get("target_count", 24)) * float(policy.get("cross_scenario_ratio", 0.0)))
    ratio_per_group = math.ceil(desired_bridge_count / len(groups)) if groups else 0
    per_group = max(1, int(policy.get("bridge_tasks_per_group", 2)), ratio_per_group)
    bridge_tasks = []
    traces = []
    files = {}
    for group in groups:
        group_id = str(group["bridge_group_id"])
        pack = context_pack(
            context.state["inputs"],
            profile_ids=list(group.get("profile_ids") or []),
            scenario_ids=list(group.get("scenario_ids") or []),
        )
        prompt = cross_context_p0_prompt(pack, group, task_count=per_group)
        item_dir = context.run_dir / "stages" / STAGE_NAME / "bridge-groups" / group_id
        write_value(item_dir / "prompt.txt", prompt)
        raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
        model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        write_value(item_dir / "model-trace.json", model_trace)
        write_value(item_dir / "parsed-output.json", raw)
        raw_tasks = raw.get("tasks") if isinstance(raw, dict) else None
        if not isinstance(raw_tasks, list) or not raw_tasks:
            raise ValueError(f"cross-context synthesis for {group_id} returned no tasks")
        normalized = []
        for index, raw_task in enumerate(raw_tasks[:per_group], start=1):
            if not isinstance(raw_task, dict):
                continue
            task = {
                "task_id": f"p0_{group_id}_task_{index:03d}",
                "name": str(raw_task.get("name") or f"cross scenario task {index}"),
                "business_goal": str(raw_task.get("business_goal") or "integrate scenario information"),
                "user_request_examples": [str(item) for item in raw_task.get("user_request_examples") or []],
                "inputs": [_field(item, field_index, "input") for field_index, item in enumerate(raw_task.get("inputs") or [], 1)],
                "outputs": [_field(item, field_index, "output") for field_index, item in enumerate(raw_task.get("outputs") or [], 1)],
                "iteration": 1,
                "evolution_direction": "initialization",
                "source_task_ids": [],
                "candidate_origin": "cross_scenario",
                "context_contract": {
                    "mode": "cross_scenario",
                    "profile_ids": list(group.get("profile_ids") or []),
                    "scenario_ids": list(group.get("scenario_ids") or []),
                    "binding_ids": list(group.get("binding_ids") or []),
                    "scenario_contributions": list(raw_task.get("scenario_contributions") or []),
                    "integration_reason": str(raw_task.get("integration_reason") or group.get("reason") or ""),
                },
            }
            if task["inputs"] and task["outputs"]:
                normalized.append(task)
                bridge_tasks.append(task)
        write_value(item_dir / "tasks.json", normalized)
        traces.append({"bridge_group_id": group_id, "task_count": len(normalized), "model_trace": model_trace})
        files[f"bridge-groups/{group_id}/prompt.txt"] = prompt
        files[f"bridge-groups/{group_id}/model-trace.json"] = model_trace
        files[f"bridge-groups/{group_id}/parsed-output.json"] = raw
        files[f"bridge-groups/{group_id}/tasks.json"] = normalized
    all_candidates = local + bridge_tasks
    if not all_candidates:
        raise ValueError("P0 synthesis produced no candidates")
    summary = {**context.state.get("summary", {}), "p0_candidates": len(all_candidates)}
    return StageExecution(
        input_payload={"bridge_groups": groups, "local_candidate_count": len(local)},
        output={"bridge_candidates": bridge_tasks, "p0_task_candidates": all_candidates},
        state_updates={"p0_bridge_candidates": bridge_tasks, "p0_task_candidates": all_candidates, "summary": summary},
        trace={"operation": "llm_cross_scenario_p0_synthesis", "groups": traces},
        files={**files, "p0-bridge-candidates.json": bridge_tasks, "p0-all-candidates.json": all_candidates},
    )
