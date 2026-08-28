from __future__ import annotations

import re
from copy import deepcopy
from typing import Any

from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, p1_generation_prompt
from .storage import write_value


STAGE_NAME = "stage3_2_p1_task_generation"
ACQUISITION_CONTRACTS = {
    "user_input": ("user_provided", "user_input", "request_user"),
    "existing_artifact": ("existing_artifact", "upstream_artifact", "provided"),
    "ordinary_tool_output": ("tool_generated", "ordinary_tool_output", "ordinary_tool"),
    "prior_skill_output": ("prior_task_output", "prior_output", "prior_task"),
}


def _safe_field_name(value: Any, fallback: str) -> str:
    name = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
    return name or fallback


def _available_options(item: dict[str, Any]) -> list[str]:
    options = list(item.get("acquisition_options") or [])
    if int((item.get("role_statistics") or {}).get("output") or 0) > 0:
        options.append("prior_skill_output")
    return list(dict.fromkeys(options))


def normalize_generated_task(
    raw_task: dict[str, Any],
    relation: dict[str, Any],
    objects: list[dict[str, Any]],
    *,
    task_index: int,
    tool_names: set[str],
) -> dict[str, Any]:
    object_by_id = {item["object_id"]: item for item in objects}
    bindings = {
        str(item.get("object_id")): item
        for item in raw_task.get("input_bindings") or []
        if isinstance(item, dict) and item.get("object_id")
    }
    inputs = []
    used_names: set[str] = set()
    for input_index, object_id in enumerate(relation["input_object_ids"], start=1):
        obj = object_by_id[object_id]
        binding = bindings.get(object_id) or {}
        options = _available_options(obj)
        acquisition = str(binding.get("acquisition") or "")
        if acquisition not in options:
            acquisition = next(
                (item for item in ("existing_artifact", "user_input", "ordinary_tool_output", "prior_skill_output") if item in options),
                "user_input",
            )
        input_origin, source, mode = ACQUISITION_CONTRACTS[acquisition]
        provider = binding.get("provider")
        if acquisition == "ordinary_tool_output" and str(provider or "") not in tool_names:
            acquisition = "user_input" if "user_input" in options else acquisition
            input_origin, source, mode = ACQUISITION_CONTRACTS[acquisition]
            provider = None
        name = _safe_field_name(obj.get("name"), f"input_{input_index}")
        if name in used_names:
            name = f"{name}_{input_index}"
        used_names.add(name)
        inputs.append({
            "name": name,
            "display_name": obj.get("display_name") or name,
            "description": obj.get("description") or name,
            "type": obj.get("type") or "object",
            "required": True,
            "object_id": object_id,
            "input_origin": input_origin,
            "source": source,
            "source_ref": object_id,
            "available": acquisition != "user_input",
            "from_task": None,
            "acquisition": {
                "mode": mode,
                "provider": provider,
                "fallback": binding.get("fallback") or "缺少该信息时返回 insufficient_input",
            },
        })
    output_obj = object_by_id[relation["output_object_id"]]
    output_name = _safe_field_name(output_obj.get("name"), "result")
    task_id = f"p1_task_{task_index:03d}"
    invocation_mode = "aggregate" if any(item["source"] == "prior_output" for item in inputs) else "standalone"
    examples = [str(item).strip() for item in raw_task.get("user_request_examples") or [] if str(item).strip()]
    if len(examples) < 2:
        examples = [
            f"帮我生成{output_obj.get('display_name') or output_name}",
            f"请根据这些信息给出{output_obj.get('display_name') or output_name}",
        ]
    return {
        "task_id": task_id,
        "name": str(raw_task.get("name") or f"帮我生成{output_obj.get('display_name') or output_name}"),
        "business_goal": str(raw_task.get("business_goal") or f"得到{output_obj.get('display_name') or output_name}"),
        "user_request_examples": examples[:4],
        "scene": "object_relation_sampled_task",
        "iteration": 2,
        "evolution_direction": "relation_sampling",
        "source_task_ids": [],
        "invocation_mode": invocation_mode,
        "parallel_group": "sampled_object_relations",
        "synthesis_decision": "skilltool",
        "decision_reason": str(raw_task.get("decision_reason") or "采样关系形成了有界的可复用任务"),
        "execution_provider": None,
        "need_ids": [],
        "inputs": inputs,
        "outputs": [{
            "name": output_name,
            "display_name": output_obj.get("display_name") or output_name,
            "description": output_obj.get("description") or output_name,
            "type": output_obj.get("type") or "object",
            "object_id": output_obj["object_id"],
            "output_origin": "task_generated",
            "dedupe_key": output_obj["object_id"],
            "inferred": True,
            "consumer_tasks": [],
            "final_consumer": "user",
        }],
        "dependencies": [],
        "estimated_steps": max(3, len(inputs) + 2),
        "fresh_data_required": bool(raw_task.get("fresh_data_required")),
        "relation_contract": {
            "relation_id": relation["relation_id"],
            "relation_signature": relation["relation_signature"],
            "input_object_ids": list(relation["input_object_ids"]),
            "output_object_id": relation["output_object_id"],
            "k": relation["k"],
            "label": f"t([{','.join(relation['input_object_ids'])}],{relation['output_object_id']})",
        },
    }


def run(context: StageContext) -> StageExecution:
    relations = list(context.state.get("sampled_relations") or [])
    objects = list((context.state.get("object_set") or {}).get("canonical_objects") or [])
    if not relations or not objects:
        raise ValueError("sampled relations and Object Set are required")
    scenario = context.state["inputs"]["scenario"]
    tool_catalog = (context.state.get("p0_base_result") or {}).get("tool_catalog") or {}
    tool_names = {str(item.get("name")) for item in tool_catalog.get("tools") or [] if isinstance(item, dict) and item.get("name")}
    candidates = []
    unrealizable = []
    traces = []
    files: dict[str, Any] = {}
    for relation_index, relation in enumerate(relations, start=1):
        prompt = p1_generation_prompt(relation, objects, scenario, tool_catalog)
        relation_id = relation["relation_id"]
        item_dir = context.run_dir / "stages" / STAGE_NAME / "relations" / relation_id
        write_value(item_dir / "prompt.txt", prompt)
        raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
        model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        write_value(item_dir / "model-trace.json", model_trace)
        write_value(item_dir / "parsed-output.json", raw)
        files[f"relations/{relation_id}/prompt.txt"] = prompt
        files[f"relations/{relation_id}/model-trace.json"] = model_trace
        files[f"relations/{relation_id}/parsed-output.json"] = raw
        if not isinstance(raw, dict) or raw.get("realizable") is not True or not isinstance(raw.get("task"), dict):
            unrealizable.append({
                "relation_id": relation_id,
                "relation_signature": relation.get("relation_signature"),
                "reasons": raw.get("unrealizable_reasons") if isinstance(raw, dict) else ["invalid model response"],
            })
            continue
        task = normalize_generated_task(
            raw["task"], relation, objects,
            task_index=relation_index,
            tool_names=tool_names,
        )
        candidates.append(task)
        write_value(item_dir / "normalized-task.json", task)
        files[f"relations/{relation_id}/normalized-task.json"] = task
        traces.append({"relation_id": relation_id, "model_trace": model_trace, "normalized_task_id": task["task_id"]})
    if not candidates:
        raise ValueError("LLM did not realize any sampled relation as a P1 task")
    return StageExecution(
        input_payload={"sampled_relations": relations, "canonical_objects": objects, "scenario": scenario},
        output={"p1_task_candidates": candidates, "unrealizable_relations": unrealizable},
        state_updates={
            "p1_task_candidates": candidates,
            "unrealizable_relations": unrealizable,
            "summary": {**context.state.get("summary", {}), "p1_candidates": len(candidates)},
        },
        trace={
            "operation": "llm_k_to_one_relation_task_realization",
            "system_prompt": RELATION_SYSTEM_PROMPT,
            "items": traces,
        },
        files={
            **files,
            "p1-task-candidates.json": candidates,
            "unrealizable-relations.json": unrealizable,
        },
    )
