from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any

from .contracts import StageContext, StageExecution
from .prompts import RELATION_SYSTEM_PROMPT, relation_extraction_prompt
from .storage import write_value


STAGE_NAME = "stage2_1_relation_extraction"
VALID_TYPES = {"object", "array", "string", "number", "boolean"}
VALID_ACQUISITIONS = {"user_input", "existing_artifact", "ordinary_tool_output", "prior_skill_output"}


def _snake(value: Any) -> str:
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", str(value or "").lower()).strip("_")


def _validate_object(raw: Any, *, role: str, task_id: str, index: int) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(f"{task_id} {role} object {index} must be an object")
    name = _snake(raw.get("name"))
    description = str(raw.get("description") or "").strip()
    value_type = str(raw.get("type") or "")
    if not name or not description or value_type not in VALID_TYPES:
        raise ValueError(f"{task_id} {role} object {index} has an incomplete semantic contract")
    acquisitions = []
    if role == "input":
        acquisitions = [
            str(item)
            for item in raw.get("acquisition_options") or []
            if str(item) in VALID_ACQUISITIONS
        ]
        if not acquisitions:
            acquisitions = ["user_input"]
    return {
        "name": name,
        "display_name": str(raw.get("display_name") or name),
        "description": description,
        "type": value_type,
        "acquisition_options": list(dict.fromkeys(acquisitions)),
    }


def run(context: StageContext) -> StageExecution:
    tasks = context.state.get("p0_tasks") or []
    if not tasks:
        raise ValueError("P0 task pool is required")
    scenario = context.state["inputs"]["scenario"]
    relations: list[dict[str, Any]] = []
    mentions: list[dict[str, Any]] = []
    item_traces: list[dict[str, Any]] = []
    files: dict[str, Any] = {}
    for task_index, task in enumerate(tasks, start=1):
        task_id = str(task.get("task_id") or f"p0_task_{task_index:03d}")
        prompt = relation_extraction_prompt(task, scenario)
        item_dir = context.run_dir / "stages" / STAGE_NAME / "tasks" / task_id
        write_value(item_dir / "prompt.txt", prompt)
        raw = context.relation_model.complete_json(system=RELATION_SYSTEM_PROMPT, user=prompt)
        write_value(item_dir / "model-trace.json", deepcopy(getattr(context.relation_model, "last_trace", {}) or {}))
        write_value(item_dir / "parsed-output.json", raw)
        if not isinstance(raw, dict):
            raise ValueError(f"relation extraction for {task_id} must return an object")
        raw_inputs = raw.get("inputs")
        raw_outputs = raw.get("outputs")
        if not isinstance(raw_inputs, list) or not raw_inputs or not isinstance(raw_outputs, list) or not raw_outputs:
            raise ValueError(f"relation extraction for {task_id} requires non-empty inputs and outputs")
        relation_inputs = []
        relation_outputs = []
        for role, raw_objects, target in (
            ("input", raw_inputs, relation_inputs),
            ("output", raw_outputs, relation_outputs),
        ):
            for object_index, raw_object in enumerate(raw_objects, start=1):
                normalized = _validate_object(raw_object, role=role, task_id=task_id, index=object_index)
                mention_id = f"mention_{task_index:03d}_{'i' if role == 'input' else 'o'}_{object_index:02d}"
                mention = {
                    "mention_id": mention_id,
                    "role": role,
                    "source_task_id": task_id,
                    "source_task_name": task.get("name"),
                    **normalized,
                }
                mentions.append(mention)
                target.append(mention_id)
        relation = {
            "relation_id": f"p0_relation_{task_index:03d}",
            "task_id": task_id,
            "task_name": task.get("name"),
            "input_mention_ids": relation_inputs,
            "output_mention_ids": relation_outputs,
            "m": len(relation_inputs),
            "n": len(relation_outputs),
            "label": f"t([{','.join(relation_inputs)}],[{','.join(relation_outputs)}])",
            "relation_summary": str(raw.get("relation_summary") or ""),
        }
        relations.append(relation)
        write_value(item_dir / "relation.json", relation)
        model_trace = deepcopy(getattr(context.relation_model, "last_trace", {}) or {})
        item_traces.append({"task_id": task_id, "prompt": prompt, "model_trace": model_trace, "parsed_output": raw})
        files[f"tasks/{task_id}/prompt.txt"] = prompt
        files[f"tasks/{task_id}/model-trace.json"] = model_trace
        files[f"tasks/{task_id}/parsed-output.json"] = raw
        files[f"tasks/{task_id}/relation.json"] = relation
    output = {"latent_relations": relations, "raw_object_mentions": mentions}
    files["latent-relations.json"] = relations
    files["raw-object-mentions.json"] = mentions
    return StageExecution(
        input_payload={"p0_tasks": tasks, "scenario": scenario},
        output=output,
        state_updates={
            **output,
            "summary": {
                **context.state.get("summary", {}),
                "latent_relations": len(relations),
            },
        },
        trace={
            "operation": "llm_p0_task_to_m_to_n_relation_extraction",
            "system_prompt": RELATION_SYSTEM_PROMPT,
            "items": item_traces,
        },
        files=files,
    )
