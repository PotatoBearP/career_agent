from __future__ import annotations

import json
import re
import sys
from copy import deepcopy
from pathlib import Path
from typing import Any


LAB_ROOT = Path(__file__).resolve().parents[2]
if str(LAB_ROOT) not in sys.path:
    sys.path.insert(0, str(LAB_ROOT))

from pipeline.mock_model import MockSynthesisModel  # noqa: E402
from pipeline.model_api import ModelConfig, OpenAICompatibleModel  # noqa: E402


VALID_TYPES = {"object", "array", "string", "number", "boolean"}


def _block(text: str, start: str, end: str) -> Any:
    value = text.split(start, 1)[1].split(end, 1)[0].strip()
    return json.loads(value)


def _snake(value: str) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9\u4e00-\u9fff]+", "_", str(value or "").lower()).strip("_")
    return normalized or "information_object"


class MockRelationModel:
    """Deterministic model used by tests and the offline UI mode."""

    def __init__(self) -> None:
        self.last_trace: dict[str, Any] = {}

    def complete_json(self, *, system: str, user: str) -> dict[str, Any]:
        if "STAGE: P0_RELATION_EXTRACTION" in user:
            output = self._relation(user)
        elif "STAGE: OBJECT_CLUSTERING" in user:
            output = self._clusters(user)
        elif "STAGE: P1_TASK_GENERATION" in user:
            output = self._p1(user)
        elif "STAGE: P1_TASK_VALIDATION" in user:
            output = self._validation()
        else:
            raise ValueError("unsupported mock relation prompt")
        self.last_trace = {
            "provider": "object_relation_mock",
            "request": {"system": system, "user": user},
            "response_content": json.dumps(output, ensure_ascii=False),
        }
        return output

    def _relation(self, user: str) -> dict[str, Any]:
        task = _block(user, "BEGIN_TASK_JSON", "END_TASK_JSON")
        inputs = []
        for index, field in enumerate(task.get("inputs") or [], start=1):
            source = str(field.get("source") or "user_input")
            option = {
                "upstream_artifact": "existing_artifact",
                "ordinary_tool_output": "ordinary_tool_output",
                "prior_output": "prior_skill_output",
            }.get(source, "user_input")
            inputs.append({
                "name": _snake(field.get("name") or f"input_{index}"),
                "display_name": field.get("display_name") or field.get("description") or field.get("name") or f"输入信息 {index}",
                "description": field.get("description") or f"完成任务所需的输入信息 {index}",
                "type": field.get("type") if field.get("type") in VALID_TYPES else "object",
                "acquisition_options": [option],
            })
        outputs = []
        for index, field in enumerate(task.get("outputs") or [], start=1):
            outputs.append({
                "name": _snake(field.get("dedupe_key") or field.get("name") or f"output_{index}"),
                "display_name": field.get("display_name") or field.get("description") or field.get("name") or f"输出信息 {index}",
                "description": field.get("description") or f"任务完成后得到的信息 {index}",
                "type": field.get("type") if field.get("type") in VALID_TYPES else "object",
            })
        if not inputs:
            inputs = [{
                "name": "user_request_context",
                "display_name": "用户请求信息",
                "description": "用户为完成当前任务提供的目标、约束与上下文",
                "type": "object",
                "acquisition_options": ["user_input"],
            }]
        if not outputs:
            outputs = [{
                "name": _snake(task.get("task_id") or "task_result") + "_result",
                "display_name": str(task.get("name") or "任务结果"),
                "description": str(task.get("business_goal") or task.get("name") or "完成任务后得到的结构化结果"),
                "type": "object",
            }]
        return {
            "task_id": task.get("task_id"),
            "inputs": inputs,
            "outputs": outputs,
            "relation_summary": "声明的输入信息足以支撑任务产生声明的输出信息。",
        }

    def _clusters(self, user: str) -> dict[str, Any]:
        mentions = _block(user, "BEGIN_OBJECT_MENTIONS_JSON", "END_OBJECT_MENTIONS_JSON")
        groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for mention in mentions:
            groups.setdefault((_snake(mention.get("name")), str(mention.get("type") or "object")), []).append(mention)
        clusters = []
        for (name, value_type), members in groups.items():
            representative = members[0]
            clusters.append({
                "canonical_name": name,
                "display_name": representative.get("display_name") or representative.get("name"),
                "description": representative.get("description") or name,
                "type": value_type,
                "member_mention_ids": [item["mention_id"] for item in members],
                "merge_reason": "规范名称和类型一致。",
            })
        return {"clusters": clusters}

    def _p1(self, user: str) -> dict[str, Any]:
        relation = _block(user, "BEGIN_RELATION_JSON", "END_RELATION_JSON")
        inputs = _block(user, "BEGIN_SELECTED_INPUT_OBJECTS_JSON", "END_SELECTED_INPUT_OBJECTS_JSON")
        output = _block(user, "BEGIN_SELECTED_OUTPUT_OBJECT_JSON", "END_SELECTED_OUTPUT_OBJECT_JSON")
        bindings = []
        for item in inputs:
            options = item.get("acquisition_options") or ["user_input"]
            acquisition = next((name for name in ("existing_artifact", "user_input", "ordinary_tool_output", "prior_skill_output") if name in options), "user_input")
            bindings.append({
                "object_id": item["object_id"],
                "acquisition": acquisition,
                "provider": None,
                "fallback": "缺少该信息时返回 insufficient_input",
            })
        input_labels = "、".join(str(item.get("display_name") or item.get("name")) for item in inputs)
        output_label = str(output.get("display_name") or output.get("name"))
        task = {
            "name": f"帮我根据{input_labels}整理{output_label}",
            "business_goal": f"利用{input_labels}得到可直接使用的{output_label}",
            "user_request_examples": [
                f"请根据我提供的{input_labels}给出{output_label}",
                f"帮我用这些信息整理一份{output_label}",
            ],
            "invocation_mode": "aggregate" if any(item["acquisition"] == "prior_skill_output" for item in bindings) else "standalone",
            "input_bindings": bindings,
            "output_object_id": relation["output_object_id"],
            "synthesis_decision": "skilltool",
            "decision_reason": "该关系表示一个有明确输入输出边界的可复用信息转换任务。",
            "fresh_data_required": False,
        }
        return {"realizable": True, "unrealizable_reasons": [], "task": task}

    @staticmethod
    def _validation() -> dict[str, Any]:
        rubrics = {
            key: "pass"
            for key in (
                "relation_fidelity",
                "input_sufficiency",
                "output_derivability",
                "scenario_alignment",
                "natural_user_request",
                "business_value",
                "scope_and_safety",
            )
        }
        return {
            "passed": True,
            "repairable": False,
            "rubrics": rubrics,
            "issues": [],
            "repair_instructions": [],
        }


def build_models(mode: str, config: dict[str, Any]) -> tuple[Any, Any, str]:
    if mode == "mock":
        return MockSynthesisModel(), MockRelationModel(), "mock"
    if mode != "api":
        raise ValueError("mode must be mock or api")
    model_config = ModelConfig.from_dict(deepcopy(config))
    base_model = OpenAICompatibleModel(model_config)
    relation_model = OpenAICompatibleModel(model_config)
    return base_model, relation_model, model_config.model

